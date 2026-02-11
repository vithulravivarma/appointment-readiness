import { Pool } from 'pg';

// 1. HARDCODED UUIDs (So relationships link up correctly)
const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const CAREGIVER_ID = '00000000-0000-0000-0000-000000000002';
const APPOINTMENT_ID = '00000000-0000-0000-0000-000000000003';
const COORDINATOR_ID = '00000000-0000-0000-0000-000000000004';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres',
});

async function seed() {
  try {
    console.log('🌱 Seeding Database with Valid UUIDs...');

    // 2. Clear existing data to avoid conflicts
    // We use CASCADE to clean up linked tables automatically
    await pool.query('TRUNCATE TABLE readiness_checks, messages, appointments, caregivers, clients, user_agents CASCADE;');

    // 3. Create CLIENT (Alice)
    await pool.query(`
      INSERT INTO clients (id, name, service_address, primary_phone)
      VALUES ($1, 'Alice Family', '123 Main St, Seattle, WA', '555-0100')
    `, [CLIENT_ID]);

    // 4. Create CAREGIVER (Bob)
    await pool.query(`
      INSERT INTO caregivers (id, name, phone)
      VALUES ($1, 'Bob Caregiver', '555-0200')
    `, [CAREGIVER_ID]);

    // 5. Create APPOINTMENT
    await pool.query(`
      INSERT INTO appointments (
        id, 
        client_id, 
        caregiver_id, 
        start_time, 
        end_time, 
        aloha_status, 
        service_type, 
        readiness_status
      )
      VALUES (
        $1, $2, $3, 
        NOW() + INTERVAL '1 day', 
        NOW() + INTERVAL '1 day 2 hours', 
        'SCHEDULED', 
        'Home Care', 
        'NOT_STARTED'
      )
    `, [APPOINTMENT_ID, CLIENT_ID, CAREGIVER_ID]);

    // 6. Create READINESS CHECKS
    // FIXED: Changed 'last_updated' to 'updated_at' to match schema.sql
    await pool.query(`
      INSERT INTO readiness_checks (appointment_id, check_type, status, updated_at)
      VALUES 
        ($1, 'ACCESS_CODE', 'PENDING', NOW()),
        ($1, 'SAFETY_ASSESSMENT', 'PENDING', NOW()),
        ($1, 'SUPPLIES', 'PENDING', NOW())
    `, [APPOINTMENT_ID]);

    // 7. Create AGENTS (Digital Twins)
    await pool.query(`
      INSERT INTO user_agents (user_id, role, status)
      VALUES 
        ($1, 'CAREGIVER', 'ACTIVE'),
        ($2, 'FAMILY', 'ACTIVE'),
        ($3, 'COORDINATOR', 'ACTIVE')
    `, [CAREGIVER_ID, CLIENT_ID, COORDINATOR_ID]);

    console.log('✅ Database Seeded Successfully!');
    console.log(`   👉 Client ID: ${CLIENT_ID}`);
    console.log(`   👉 Caregiver ID: ${CAREGIVER_ID}`);
    console.log(`   👉 Appointment ID: ${APPOINTMENT_ID}`);

  } catch (err) {
    console.error('❌ Seeding Failed:', err);
    process.exit(1); // Exit with error code so we know it failed
  } finally {
    await pool.end();
  }
}

seed();