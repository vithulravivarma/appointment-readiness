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
  assistant: {
    delegationCompletionNotifyV1: boolean;
  };
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || String(SERVICE_PORTS.AI_INTERPRETER), 10);
  const databaseUrl = process.env.DATABASE_URL;
  
  // Database connection limit (Default to 5 if not set)
  const maxConnections = parseInt(process.env.DB_MAX_CONN || '5', 10);

  const sqsEndpoint = process.env.SQS_ENDPOINT;
  const sqsRegion = process.env.AWS_REGION || 'us-east-1';
  const sqsAccessKeyId = process.env.AWS_ACCESS_KEY_ID || 'test';
  const sqsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || 'test';
  const delegationCompletionNotifyV1Raw = String(process.env.ASSISTANT_DELEGATION_COMPLETION_NOTIFY_V1 || 'true').toLowerCase();
  const delegationCompletionNotifyV1 =
    delegationCompletionNotifyV1Raw === '1' ||
    delegationCompletionNotifyV1Raw === 'true' ||
    delegationCompletionNotifyV1Raw === 'yes';

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
    assistant: {
      delegationCompletionNotifyV1,
    },
  };
}
