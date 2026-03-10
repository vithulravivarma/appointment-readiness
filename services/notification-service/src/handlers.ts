import { Message } from '@aws-sdk/client-sqs';
import { NotificationJob, QUEUES } from '@ar/types';
import { loadConfig } from './config';
import { getDb } from './db';
import { NonRetryableMessageError, subscribeToQueue } from './sqs';

const config = loadConfig();

function normalizePhoneEndpoint(value: unknown): string {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('whatsapp:')) {
    raw = raw.slice('whatsapp:'.length).trim();
  }
  raw = raw.replace(/[\s()-]/g, '');
  if (/^\d+$/.test(raw)) {
    raw = `+${raw}`;
  }
  if (!/^\+\d{7,15}$/.test(raw)) return '';
  return raw;
}

function formatTwilioWhatsAppEndpoint(value: string): string {
  const normalized = normalizePhoneEndpoint(value);
  if (!normalized) return '';
  return `whatsapp:${normalized}`;
}

function isAllowlistedForTrial(endpoint: string): boolean {
  if (!config.whatsapp.trialMode) return true;
  if (config.whatsapp.allowlistNumbers.length === 0) return true;
  const allowSet = new Set(
    config.whatsapp.allowlistNumbers
      .map((item) => normalizePhoneEndpoint(item))
      .filter(Boolean),
  );
  return allowSet.has(normalizePhoneEndpoint(endpoint));
}

async function persistWhatsAppDeliveryEvent(input: {
  providerMessageId: string;
  status: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const pool = getDb();
  if (!pool) return;
  try {
    await pool.query(
      `
        INSERT INTO webhook_inbox_events (
          provider,
          provider_message_id,
          event_type,
          status,
          payload,
          processed_at
        )
        VALUES ($1, $2, 'OUTBOUND', $3, $4::jsonb, NOW())
        ON CONFLICT (provider, provider_message_id)
        DO UPDATE SET
          event_type = EXCLUDED.event_type,
          status = EXCLUDED.status,
          payload = webhook_inbox_events.payload || EXCLUDED.payload,
          processed_at = NOW()
      `,
      ['twilio_whatsapp_outbound', input.providerMessageId, input.status, JSON.stringify(input.payload)],
    );
  } catch (error) {
    console.warn('[NOTIFICATION] Failed to persist webhook delivery event', {
      providerMessageId: input.providerMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendWhatsAppViaTwilio(job: NotificationJob): Promise<void> {
  if (!config.whatsapp.enabled) {
    throw new NonRetryableMessageError('WHATSAPP notifications are disabled', 'WHATSAPP_DISABLED');
  }
  if (!config.whatsapp.twilioAccountSid || !config.whatsapp.twilioApiKeySid || !config.whatsapp.twilioApiKeySecret) {
    throw new NonRetryableMessageError('Missing Twilio credentials for WHATSAPP delivery', 'MISSING_TWILIO_CREDENTIALS');
  }

  const toEndpoint = normalizePhoneEndpoint(job.toEndpoint || job.recipient);
  if (!toEndpoint) {
    throw new NonRetryableMessageError('WHATSAPP notification missing valid recipient endpoint', 'INVALID_WHATSAPP_RECIPIENT');
  }
  if (!isAllowlistedForTrial(toEndpoint)) {
    throw new NonRetryableMessageError('WHATSAPP recipient is not allowlisted in trial mode', 'WHATSAPP_NOT_ALLOWLISTED');
  }

  const fromEndpoint = formatTwilioWhatsAppEndpoint(job.fromEndpoint || config.whatsapp.twilioWhatsAppFrom);
  const toTwilio = formatTwilioWhatsAppEndpoint(toEndpoint);
  if (!fromEndpoint || !toTwilio) {
    throw new NonRetryableMessageError('Invalid WHATSAPP endpoint formatting for Twilio send', 'INVALID_WHATSAPP_ENDPOINT');
  }

  const replyText = String(job.data?.replyText || '').trim();
  if (!replyText) {
    throw new NonRetryableMessageError('WHATSAPP notification missing reply text', 'MISSING_WHATSAPP_TEXT');
  }

  const body = new URLSearchParams();
  body.set('To', toTwilio);
  body.set('From', fromEndpoint);
  body.set('Body', replyText);

  const basicAuth = Buffer.from(`${config.whatsapp.twilioApiKeySid}:${config.whatsapp.twilioApiKeySecret}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.whatsapp.twilioAccountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const providerMessageId = String(payload.sid || '').trim();
  if (!response.ok) {
    const errorCode = String(payload.code || '').trim();
    const errorMessage = String(payload.message || `Twilio API request failed with status ${response.status}`);
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new NonRetryableMessageError(
        `Twilio WHATSAPP send rejected (${errorCode || response.status}): ${errorMessage}`,
        'TWILIO_WHATSAPP_SEND_REJECTED',
      );
    }
    throw new Error(`Twilio WHATSAPP send failed (${errorCode || response.status}): ${errorMessage}`);
  }

  if (!providerMessageId) {
    throw new Error('Twilio WHATSAPP send succeeded but no sid was returned');
  }

  await persistWhatsAppDeliveryEvent({
    providerMessageId,
    status: String(payload.status || 'QUEUED').toUpperCase(),
    payload: {
      ...payload,
      conversationRef: job.conversationRef || null,
      correlationId: job.correlationId || null,
      templateId: job.templateId,
      provider: job.provider || 'TWILIO_WHATSAPP',
    },
  });

  console.log('[NOTIFICATION] 📲 WHATSAPP sent', {
    to: toEndpoint,
    from: fromEndpoint,
    providerMessageId,
  });
}

export async function handleNotification(message: Message): Promise<void> {
  if (!message.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }

  let job: NotificationJob;
  try {
    job = JSON.parse(message.Body) as NotificationJob;
  } catch {
    throw new NonRetryableMessageError('Invalid JSON for notification event', 'INVALID_JSON');
  }

  if (!String(job.type || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing type', 'MISSING_TYPE');
  }
  if (!String(job.recipient || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing recipient', 'MISSING_RECIPIENT');
  }
  if (!String(job.templateId || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing templateId', 'MISSING_TEMPLATE_ID');
  }

  console.log(`[NOTIFICATION] 📨 Processing ${job.type} for ${job.recipient}`);
  console.log(`[NOTIFICATION]    Template: ${job.templateId}`);
  console.log('[NOTIFICATION]    Context:', job.data);

  if (job.type === 'WHATSAPP') {
    await sendWhatsAppViaTwilio(job);
    console.log('[NOTIFICATION] ✅ WHATSAPP sent successfully.');
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log('[NOTIFICATION] ✅ Sent successfully.');
}

export async function initializeConsumers(sqsClient: any): Promise<void> {
  await subscribeToQueue(sqsClient, QUEUES.NOTIFICATION, handleNotification);
}
