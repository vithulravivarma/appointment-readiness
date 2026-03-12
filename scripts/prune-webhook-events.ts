import dotenv from 'dotenv';
import path from 'path';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseRetentionDays(): number {
  const raw = Number(process.argv[2] || process.env.WHATSAPP_STATUS_RETENTION_DAYS || '30');
  if (!Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(3650, Math.trunc(raw)));
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const retentionDays = parseRetentionDays();
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const result = await db.query(
      `
        DELETE FROM webhook_inbox_events
        WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
        RETURNING id
      `,
      [retentionDays],
    );

    console.log(
      JSON.stringify({
        success: true,
        retentionDays,
        deletedCount: result.rowCount || 0,
      }),
    );
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('Failed to prune webhook_inbox_events:', error);
  process.exit(1);
});
