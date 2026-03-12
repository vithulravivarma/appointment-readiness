import dotenv from 'dotenv';
import path from 'path';
import { Client } from 'pg';
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { QUEUES } from '../shared/types/src/platform';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseLimitArg(): number {
  const value = Number(process.argv[2] || '50');
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const limit = parseLimitArg();
  const region = String(process.env.AWS_REGION || 'us-east-1').trim();
  const endpoint = String(process.env.SQS_ENDPOINT || '').trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || 'test').trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || 'test').trim();

  const db = new Client({ connectionString: databaseUrl });
  const sqs = new SQSClient({
    region,
    endpoint: endpoint || undefined,
    credentials: { accessKeyId, secretAccessKey },
  });

  await db.connect();
  try {
    const queueUrlRes = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.INCOMING_MESSAGES }));
    const queueUrl = String(queueUrlRes.QueueUrl || '').trim();
    if (!queueUrl) throw new Error(`Queue URL not found for ${QUEUES.INCOMING_MESSAGES}`);

    const rows = await db.query(
      `
        SELECT provider_message_id, payload
        FROM webhook_inbox_events
        WHERE provider = 'twilio_whatsapp'
          AND status = 'FAILED_PROCESSING_RETRYABLE'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit],
    );

    let replayed = 0;
    let skipped = 0;
    for (const row of rows.rows) {
      const messageSid = String(row.provider_message_id || '').trim();
      const payload = (row.payload || {}) as Record<string, unknown>;

      const appointmentId = String(payload.appointmentId || '').trim();
      const messageId = String(payload.messageId || '').trim();
      const senderId = String(payload.senderId || '').trim();
      const text = String(payload.text || '').trim();
      const fromEndpoint = String(payload.fromEndpoint || '').trim();
      const toEndpoint = String(payload.toEndpoint || '').trim();
      if (!messageSid || !appointmentId || !messageId || !senderId || !text) {
        skipped += 1;
        continue;
      }

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            type: 'NEW_MESSAGE',
            appointmentId,
            text,
            senderType: 'FAMILY',
            senderId,
            messageId,
            channel: 'WHATSAPP',
            provider: 'TWILIO_WHATSAPP',
            fromEndpoint,
            toEndpoint,
            externalMessageId: messageSid,
          }),
        }),
      );

      await db.query(
        `
          UPDATE webhook_inbox_events
          SET status = 'REPLAYED_QUEUED',
              payload = payload || $3::jsonb,
              processed_at = NOW()
          WHERE provider = $1 AND provider_message_id = $2
        `,
        ['twilio_whatsapp', messageSid, JSON.stringify({ replayedAt: new Date().toISOString(), replaySource: 'script' })],
      );
      replayed += 1;
    }

    console.log(
      JSON.stringify({
        success: true,
        attempted: rows.rowCount || 0,
        replayed,
        skipped,
      }),
    );
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('Failed to replay failed WhatsApp inbound events:', error);
  process.exit(1);
});
