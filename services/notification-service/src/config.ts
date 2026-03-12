import dotenv from 'dotenv';
import path from 'path';
import { SERVICE_PORTS } from '@ar/types';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

export interface Config {
  port: number;
  database: {
    url: string;
    maxConnections: number;
  };
  sqs: {
    endpoint?: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  whatsapp: {
    enabled: boolean;
    trialMode: boolean;
    allowlistNumbers: string[];
    maxInboundChars: number;
    rateLimitPerEndpoint: number;
    statusRetentionDays: number;
    redactLogs: boolean;
    twilioAccountSid: string;
    twilioApiKeySid: string;
    twilioApiKeySecret: string;
    twilioAuthToken: string;
    twilioWhatsAppFrom: string;
  };
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || String(SERVICE_PORTS.NOTIFICATION_SERVICE), 10);
  const databaseUrl = process.env.DATABASE_URL;
  
  // Database connection limit (Default to 5 if not set)
  const maxConnections = parseInt(process.env.DB_MAX_CONN || '5', 10);

  const sqsEndpoint = process.env.SQS_ENDPOINT;
  const sqsRegion = process.env.AWS_REGION || 'us-east-1';
  const sqsAccessKeyId = process.env.AWS_ACCESS_KEY_ID || 'test';
  const sqsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || 'test';
  const whatsappEnabledRaw = String(process.env.WHATSAPP_ENABLED || 'true').toLowerCase();
  const whatsappTrialModeRaw = String(process.env.WHATSAPP_TRIAL_MODE || 'false').toLowerCase();
  const whatsappAllowlistRaw = String(process.env.WHATSAPP_ALLOWLIST_NUMBERS || '').trim();
  const whatsappMaxInboundCharsRaw = Number(process.env.WHATSAPP_MAX_INBOUND_CHARS || '2000');
  const whatsappRateLimitPerEndpointRaw = Number(process.env.WHATSAPP_RATE_LIMIT_PER_ENDPOINT || '30');
  const whatsappStatusRetentionDaysRaw = Number(process.env.WHATSAPP_STATUS_RETENTION_DAYS || '30');
  const whatsappRedactLogsRaw = String(process.env.WHATSAPP_REDACT_LOGS || 'true').toLowerCase();
  const whatsappEnabled = whatsappEnabledRaw === '1' || whatsappEnabledRaw === 'true' || whatsappEnabledRaw === 'yes';
  const whatsappTrialMode =
    whatsappTrialModeRaw === '1' || whatsappTrialModeRaw === 'true' || whatsappTrialModeRaw === 'yes';
  const whatsappRedactLogs =
    whatsappRedactLogsRaw === '1' || whatsappRedactLogsRaw === 'true' || whatsappRedactLogsRaw === 'yes';
  const whatsappAllowlistNumbers = whatsappAllowlistRaw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const whatsappMaxInboundChars = Number.isFinite(whatsappMaxInboundCharsRaw)
    ? Math.max(1, Math.min(10000, Math.trunc(whatsappMaxInboundCharsRaw)))
    : 2000;
  const whatsappRateLimitPerEndpoint = Number.isFinite(whatsappRateLimitPerEndpointRaw)
    ? Math.max(1, Math.min(600, Math.trunc(whatsappRateLimitPerEndpointRaw)))
    : 30;
  const whatsappStatusRetentionDays = Number.isFinite(whatsappStatusRetentionDaysRaw)
    ? Math.max(1, Math.min(3650, Math.trunc(whatsappStatusRetentionDaysRaw)))
    : 30;
  const twilioAccountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const twilioApiKeySid = String(process.env.TWILIO_API_KEY_SID || '').trim();
  const twilioApiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || '').trim();
  const twilioAuthToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  const twilioWhatsAppFrom = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    port,
    database: {
      url: databaseUrl,
      maxConnections,
    },
    sqs: {
      endpoint: sqsEndpoint,
      region: sqsRegion,
      accessKeyId: sqsAccessKeyId,
      secretAccessKey: sqsSecretAccessKey,
    },
    whatsapp: {
      enabled: whatsappEnabled,
      trialMode: whatsappTrialMode,
      allowlistNumbers: whatsappAllowlistNumbers,
      maxInboundChars: whatsappMaxInboundChars,
      rateLimitPerEndpoint: whatsappRateLimitPerEndpoint,
      statusRetentionDays: whatsappStatusRetentionDays,
      redactLogs: whatsappRedactLogs,
      twilioAccountSid,
      twilioApiKeySid,
      twilioApiKeySecret,
      twilioAuthToken,
      twilioWhatsAppFrom,
    },
  };
}
