import crypto from 'crypto';
import type { Message } from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';

export type ProcessedOutcome = 'SUCCEEDED' | 'DROPPED_NON_RETRYABLE';

export type PersistentIdempotencyKey = {
  consumerName: string;
  queueName: string;
  messageId: string;
  bodyHash: string;
};

type PersistentStoreOptions = {
  ttlHours: number;
  pruneIntervalMs: number;
};

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function loadPersistentStoreOptions(): PersistentStoreOptions {
  return {
    ttlHours: parseIntEnv('SQS_PERSISTENT_IDEMPOTENCY_TTL_HOURS', 168, 1, 24 * 365),
    pruneIntervalMs: parseIntEnv('SQS_PERSISTENT_IDEMPOTENCY_PRUNE_INTERVAL_MS', 5 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
  };
}

const PERSISTENT_STORE_OPTIONS = loadPersistentStoreOptions();

let tableEnsured = false;
let nextPruneAtMs = 0;

export function buildPersistentIdempotencyKey(
  consumerName: string,
  queueName: string,
  message: Message,
): PersistentIdempotencyKey | null {
  const messageId = String(message.MessageId || '').trim();
  if (!messageId) return null;
  const bodyHash = crypto.createHash('sha1').update(String(message.Body || '')).digest('hex');
  return {
    consumerName: String(consumerName || '').trim(),
    queueName: String(queueName || '').trim(),
    messageId,
    bodyHash,
  };
}

async function ensurePersistentTable(pool: Pool): Promise<void> {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_idempotency (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      consumer_name VARCHAR(160) NOT NULL,
      queue_name VARCHAR(160) NOT NULL,
      message_id VARCHAR(255) NOT NULL,
      body_hash VARCHAR(64) NOT NULL,
      processed_outcome VARCHAR(64) NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (consumer_name, queue_name, message_id, body_hash)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_message_idempotency_expires_at
    ON message_idempotency(expires_at)
  `);
  tableEnsured = true;
}

async function maybePruneExpired(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now < nextPruneAtMs) return;
  nextPruneAtMs = now + PERSISTENT_STORE_OPTIONS.pruneIntervalMs;
  await pool.query(`DELETE FROM message_idempotency WHERE expires_at <= NOW()`);
}

export async function hasPersistentProcessedMessage(
  pool: Pool,
  key: PersistentIdempotencyKey,
): Promise<boolean> {
  await ensurePersistentTable(pool);
  await maybePruneExpired(pool);
  const res = await pool.query(
    `
      SELECT 1
      FROM message_idempotency
      WHERE consumer_name = $1
        AND queue_name = $2
        AND message_id = $3
        AND body_hash = $4
        AND expires_at > NOW()
      LIMIT 1
    `,
    [key.consumerName, key.queueName, key.messageId, key.bodyHash],
  );
  return res.rows.length > 0;
}

export async function markPersistentProcessedMessage(
  pool: Pool,
  key: PersistentIdempotencyKey,
  outcome: ProcessedOutcome,
  meta?: Record<string, unknown>,
): Promise<void> {
  await ensurePersistentTable(pool);
  const expiresAt = new Date(Date.now() + PERSISTENT_STORE_OPTIONS.ttlHours * 60 * 60 * 1000).toISOString();
  await pool.query(
    `
      INSERT INTO message_idempotency (
        consumer_name,
        queue_name,
        message_id,
        body_hash,
        processed_outcome,
        processed_at,
        expires_at,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6::timestamptz, $7::jsonb)
      ON CONFLICT (consumer_name, queue_name, message_id, body_hash)
      DO UPDATE SET
        processed_outcome = EXCLUDED.processed_outcome,
        processed_at = EXCLUDED.processed_at,
        expires_at = EXCLUDED.expires_at,
        meta = EXCLUDED.meta
    `,
    [
      key.consumerName,
      key.queueName,
      key.messageId,
      key.bodyHash,
      outcome,
      expiresAt,
      JSON.stringify(meta || {}),
    ],
  );
}
