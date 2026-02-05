import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const projectRoot = process.cwd();

// Load .env from root
const envPath = path.resolve(projectRoot, '.env');
dotenv.config({ path: envPath });

async function migrate() {
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    console.error('❌ DATABASE_URL is missing in .env');
    console.error(`   Looking in: ${envPath}`);
    process.exit(1);
  }

  console.log('🐘 Connecting to Postgres...');
  const client = new Client({ connectionString: dbUrl });

  try {
    await client.connect();
    
    // Locate the schema file relative to the project root
    const schemaPath = path.resolve(projectRoot, 'migrations/schema.sql');
    console.log(`📂 Reading schema from ${schemaPath}...`);
    
    if (!fs.existsSync(schemaPath)) {
        throw new Error(`Schema file not found at ${schemaPath}`);
    }

    const sql = fs.readFileSync(schemaPath, 'utf8');
    
    console.log('🚀 Running migration...');
    await client.query(sql);
    
    console.log('✅ Schema applied successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();