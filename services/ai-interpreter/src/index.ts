import { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
// Make sure you have these standard imports or adjust paths
import { loadConfig } from './config'; 
import { initializeDatabase } from './db';
import { initializeConsumers } from './handlers';
import express from 'express'; // Optional, but good for health checks

async function main() {
  console.log('[STARTUP] 🧠 Starting AI Interpreter Service...');

  try {
    // 1. Config & DB
    const config = loadConfig();
    const pool = initializeDatabase(config.database);
    
    // 2. AWS SQS Setup
    const sqs = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      }
    });

    // 3. Start Consumers (The Logic)
    await initializeConsumers(sqs, pool);

    // 4. (Optional) Simple Health Check Server
    const app = express();
    app.get('/health', (req, res) => res.send('OK'));
    app.listen(config.port, () => {
      console.log(`[STARTUP] ✓ Health Server running on port ${config.port}`);
    });

    console.log('[STARTUP] ✓ Service fully operational');

    // Graceful Shutdown
    const shutdown = async () => {
      console.log('[SHUTDOWN] Closing connections...');
      await pool.end();
      process.exit(0);
    };
    
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    console.error('[STARTUP] ✗ Fatal error:', error);
    process.exit(1);
  }
}

main();
