import { Pool } from 'pg';

export interface IngestionPayload {
  alohaAppointmentId: string;
  startTime: string;
  endTime: string;
  serviceType: string;
  location: string;
  client: {
    alohaId: string;
    name: string;
    phone: string;
    address: string;
  };
  caregiver: {
    alohaId: string;
    name: string;
    phone: string;
    email: string;
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
    `, [data.client.alohaId, data.client.name, data.client.phone, data.client.address]);
    
    const internalClientId = clientRes.rows[0].id;

    // 2. Upsert CAREGIVER
    const caregiverRes = await client.query(`
      INSERT INTO caregivers (aloha_caregiver_id, name, phone, email)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (aloha_caregiver_id) 
      DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone
      RETURNING id
    `, [data.caregiver.alohaId, data.caregiver.name, data.caregiver.phone, data.caregiver.email]);
    
    const internalCaregiverId = caregiverRes.rows[0].id;

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

    // 4. Initialize READINESS State (If new)
    // We strictly ignore conflicts here; we don't want to reset status if it's already IN_PROGRESS
    await client.query(`
      INSERT INTO appointment_readiness (appointment_id, status)
      VALUES ($1, 'NOT_STARTED')
      ON CONFLICT (appointment_id) DO NOTHING
    `, [internalAppointmentId]);

    await client.query('COMMIT');
    
    return internalAppointmentId; // Return the UUID
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}