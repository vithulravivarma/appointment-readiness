import { Pool } from 'pg';
import { Config } from './config';

let pool: Pool | null = null;

export function initializeDatabase(config: Config['database']): Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected error on idle database client', err);
  });

  return pool;
}

export async function testConnection(pool: Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('[DB] Connection test successful');
    return true;
  } catch (error) {
    console.error('[DB] Connection test failed:', error);
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function getDb(): Pool | null {
  return pool;
}
