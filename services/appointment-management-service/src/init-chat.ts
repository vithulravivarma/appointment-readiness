import { loadConfig } from './config';
import { initializeDatabase } from './db';
// ... imports

async function run() {
  const config = loadConfig();
  const pool = initializeDatabase(config.database);

  console.log('🚧 Resetting Chat Architecture...');

  // 1. DROP THE OLD TABLE (Add this line!)
  await pool.query('DROP TABLE IF EXISTS messages;');

  // 2. Create the Strict Type
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE sender_type_enum AS ENUM ('CAREGIVER', 'COORDINATOR', 'FAMILY', 'SYSTEM');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // 3. Create the Messages Table (Now it will definitely create the new version)
  await pool.query(`
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id UUID NOT NULL,
      sender_type sender_type_enum NOT NULL,
      sender_id VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX idx_messages_appt ON messages(appointment_id);
  `);

  console.log('✅ Chat Database Reset & Ready.');
  process.exit();
}

run();