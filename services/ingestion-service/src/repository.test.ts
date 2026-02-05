import { Pool } from 'pg';
import { upsertAppointment } from './repository';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars so we can connect to the Docker DB
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Ingestion Repository (Integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  test('should successfully upsert a new appointment', async () => {
    const mockData = {
      alohaAppointmentId: `TEST-Integration-${Date.now()}`,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      serviceType: 'TDD Therapy',
      location: 'Test Lab',
      client: {
        alohaId: 'CLI-TDD-1',
        name: 'Test Client',
        phone: '555-TDD',
        address: '123 Test St'
      },
      caregiver: {
        alohaId: 'CG-TDD-1',
        name: 'Test Caregiver',
        phone: '555-CARE',
        email: 'test@example.com'
      }
    };

    // 1. Run Upsert
    const internalId = await upsertAppointment(pool, mockData);
    expect(internalId).toBeDefined();

    // 2. Verify in DB
    const res = await pool.query('SELECT * FROM appointments WHERE id = $1', [internalId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].aloha_appointment_id).toBe(mockData.alohaAppointmentId);
  });
});