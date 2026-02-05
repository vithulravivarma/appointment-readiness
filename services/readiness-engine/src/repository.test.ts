import { Pool } from 'pg';
import { getReadinessState, ensureChecklistExists } from './repository';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Readiness Repository (Integration)', () => {
  let pool: Pool;
  const testId = `TEST-READ-${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    // SETUP: Create the dependencies in the DB so we have something to read
    // 1. Create Client
    const clientRes = await pool.query(`
      INSERT INTO clients (aloha_client_id, name, primary_phone)
      VALUES ('CLI-TEST', 'Read Test Client', '555-READ') RETURNING id
    `);
    
    // 2. Create Caregiver
    const cgRes = await pool.query(`
      INSERT INTO caregivers (aloha_caregiver_id, name, phone)
      VALUES ('CG-TEST', 'Read Test CG', '555-CG') RETURNING id
    `);

    // 3. Create Appointment
    const aptRes = await pool.query(`
      INSERT INTO appointments (aloha_appointment_id, client_id, caregiver_id, start_time, end_time)
      VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id
    `, [testId, clientRes.rows[0].id, cgRes.rows[0].id]);

    const internalId = aptRes.rows[0].id;

    // 4. Create Readiness Record
    await pool.query(`
      INSERT INTO appointment_readiness (appointment_id, status) VALUES ($1, 'NOT_STARTED')
    `, [internalId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('should fetch correct state and checks', async () => {
    // 1. Get the internal UUID for our test ID
    const res = await pool.query('SELECT id FROM appointments WHERE aloha_appointment_id = $1', [testId]);
    const internalId = res.rows[0].id;

    // 2. Ensure checks exist (using the function we wrote)
    await ensureChecklistExists(pool, internalId);

    // 3. TEST: Read it back
    const state = await getReadinessState(pool, internalId);

    // 4. Verify
    expect(state.appointmentId).toBe(internalId);
    expect(state.status).toBe('NOT_STARTED');
    expect(state.checks.length).toBeGreaterThan(0); // Should have default checks like ACCESS_CODE
    expect(state.checks[0].status).toBe('PENDING');
  });
});