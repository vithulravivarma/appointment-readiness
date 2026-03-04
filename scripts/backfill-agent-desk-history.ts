import crypto from 'crypto';
import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

type AssistantTurn = {
  role?: string;
  content?: string;
  createdAt?: string;
  appointmentId?: string;
};

function normalizeOptionalUuid(value: unknown): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : null;
}

function buildDedupeKey(input: {
  caregiverId: string;
  role: string;
  content: string;
  createdAt: string;
}): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${input.role}|${input.content}`)
    .digest('hex')
    .slice(0, 16);
  return `backfill-desk-turn:${input.caregiverId}:${input.createdAt}:${input.role}:${hash}`;
}

async function ensureThread(client: Client, caregiverId: string): Promise<string> {
  const existing = await client.query(
    `
      SELECT id::text
      FROM agent_desk_threads
      WHERE caregiver_id = $1
      LIMIT 1
    `,
    [caregiverId],
  );
  if (existing.rows.length > 0) {
    return String(existing.rows[0].id);
  }

  const inserted = await client.query(
    `
      INSERT INTO agent_desk_threads (caregiver_id)
      VALUES ($1)
      ON CONFLICT (caregiver_id)
      DO UPDATE SET caregiver_id = EXCLUDED.caregiver_id
      RETURNING id::text
    `,
    [caregiverId],
  );
  return String(inserted.rows[0].id);
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const res = await client.query(
      `
        SELECT user_id::text, persona_settings
        FROM user_agents
        WHERE role = 'CAREGIVER'
      `,
    );

    let totalInserted = 0;
    let totalThreads = 0;

    for (const row of res.rows) {
      const caregiverId = String(row.user_id || '').trim();
      if (!caregiverId) continue;
      const settings = (row.persona_settings || {}) as any;
      const history: AssistantTurn[] = Array.isArray(settings?.assistant?.history)
        ? settings.assistant.history
        : [];
      if (history.length === 0) continue;

      const threadId = await ensureThread(client, caregiverId);
      totalThreads += 1;

      for (const turn of history) {
        const role = String(turn.role || '').toUpperCase() === 'CAREGIVER' ? 'CAREGIVER' : 'ASSISTANT';
        const content = String(turn.content || '').trim();
        const createdAt = String(turn.createdAt || '').trim() || new Date().toISOString();
        if (!content) continue;
        const dedupeKey = buildDedupeKey({
          caregiverId,
          role,
          content,
          createdAt,
        });

        const insertRes = await client.query(
          `
            INSERT INTO agent_desk_messages (
              thread_id,
              appointment_id,
              actor_type,
              content,
              source,
              metadata,
              dedupe_key,
              created_at
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              'BACKFILL',
              $5::jsonb,
              $6,
              $7::timestamptz
            )
            ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
            RETURNING id
          `,
          [
            threadId,
            normalizeOptionalUuid(turn.appointmentId),
            role,
            content,
            JSON.stringify({ from: 'user_agents.persona_settings.assistant.history' }),
            dedupeKey,
            createdAt,
          ],
        );
        if (insertRes.rows.length > 0) {
          totalInserted += 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          caregiversProcessed: res.rows.length,
          threadsTouched: totalThreads,
          insertedMessages: totalInserted,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
