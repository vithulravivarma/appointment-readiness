import { Pool, PoolClient } from 'pg';

export interface IngestionPayload {
  alohaAppointmentId: string;
  startTime: string;
  endTime: string;
  serviceType: string;
  location: string;
  client: {
    alohaId: string;
    name: string;
    phone?: string;
    address?: string;
  };
  caregiver: {
    alohaId: string;
    name: string;
    phone?: string;
    email?: string;
    homeAddress?: string;
  };
}

export async function upsertAppointment(pool: Pool, data: IngestionPayload): Promise<string> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Upsert CLIENT
    // We use ON CONFLICT to update if they already exist (idempotency)
    const clientRes = await client.query(`
      INSERT INTO clients (aloha_client_id, name, primary_phone, service_address)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (aloha_client_id) 
      DO UPDATE SET name = EXCLUDED.name, primary_phone = EXCLUDED.primary_phone
      RETURNING id
    `, [
      data.client.alohaId,
      data.client.name,
      data.client.phone || null,
      data.client.address || null,
    ]);
    
    const internalClientId = clientRes.rows[0].id;

    // 2. Upsert CAREGIVER
    const caregiverRes = await client.query(`
      INSERT INTO caregivers (aloha_caregiver_id, name, phone, email, home_address)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (aloha_caregiver_id) 
      DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        home_address = COALESCE(EXCLUDED.home_address, caregivers.home_address)
      RETURNING id
    `, [
      data.caregiver.alohaId,
      data.caregiver.name,
      data.caregiver.phone || null,
      data.caregiver.email || null,
      data.caregiver.homeAddress || null,
    ]);
    
    const internalCaregiverId = caregiverRes.rows[0].id;

    await upsertAuthUser(
      client,
      {
        role: 'FAMILY',
        personId: internalClientId,
        displayName: data.client.name,
        externalId: data.client.alohaId,
      },
    );

    await upsertAuthUser(
      client,
      {
        role: 'CAREGIVER',
        personId: internalCaregiverId,
        displayName: data.caregiver.name,
        externalId: data.caregiver.alohaId,
      },
    );

    // 3. Upsert APPOINTMENT
    const appointmentRes = await client.query(`
      INSERT INTO appointments (
        aloha_appointment_id, client_id, caregiver_id, 
        start_time, end_time, service_type, location_address
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (aloha_appointment_id) 
      DO UPDATE SET 
        start_time = EXCLUDED.start_time,
        caregiver_id = EXCLUDED.caregiver_id
      RETURNING id
    `, [
      data.alohaAppointmentId, 
      internalClientId, 
      internalCaregiverId,
      data.startTime,
      data.endTime,
      data.serviceType,
      data.location
    ]);

    const internalAppointmentId = appointmentRes.rows[0].id;

    // 4. No separate readiness table is needed.
    // Readiness state lives on appointments.readiness_status in the current schema.

    await client.query('COMMIT');
    
    return internalAppointmentId; // Return the UUID
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

interface AuthProvisionInput {
  role: 'CAREGIVER' | 'FAMILY';
  personId: string;
  displayName: string;
  externalId: string;
}

async function upsertAuthUser(
  client: PoolClient,
  input: AuthProvisionInput,
): Promise<void> {
  const usernamePrefix = input.role === 'CAREGIVER' ? 'cg' : 'pt';
  const external = (input.externalId || input.personId).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const personToken = input.personId.replace(/-/g, '').slice(0, 6);
  const suffix = external || personToken;
  const username = `${usernamePrefix}-${suffix}-${personToken}`;

  await client.query(
    `
      INSERT INTO auth_users (username, password_plaintext, role, person_id, display_name)
      VALUES ($1, 'demo123', $2, $3::uuid, $4)
      ON CONFLICT (role, person_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        updated_at = NOW()
    `,
    [username, input.role, input.personId, input.displayName],
  );
}
