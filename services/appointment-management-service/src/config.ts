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
  googleMaps: {
    apiKey: string;
  };
  openai: {
    apiKey: string;
    model: string;
  };
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT || String(SERVICE_PORTS.APPOINTMENT_MANAGEMENT), 10);
  const databaseUrl = process.env.DATABASE_URL;
  
  // Database connection limit (Default to 5 if not set)
  const maxConnections = parseInt(process.env.DB_MAX_CONN || '5', 10);

  const sqsEndpoint = process.env.SQS_ENDPOINT;
  const sqsRegion = process.env.AWS_REGION || 'us-east-1';
  const sqsAccessKeyId = process.env.AWS_ACCESS_KEY_ID || 'test';
  const sqsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || 'test';
  const googleMapsApiKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  const openaiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const openaiModel = String(process.env.AGENT_ASSISTANT_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';

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
    googleMaps: {
      apiKey: googleMapsApiKey,
    },
    openai: {
      apiKey: openaiApiKey,
      model: openaiModel,
    },
  };
}
