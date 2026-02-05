import { Server } from 'http';
import { Request, Response } from 'express'; // <--- NEW: Needed for route types
import { loadConfig } from './config';
import { initializeDatabase, testConnection, closeDatabase } from './db';
import { initializeSQS, publishMessage } from './sqs'; // <--- NEW: Import publishMessage
import { createServer } from './server';
import { initializeConsumers } from './handlers';
import { upsertAppointment } from './repository';
import { ReadinessEvaluationEvent } from '@ar/types';

interface StartupContext {
  config: ReturnType<typeof loadConfig>;
  pool: ReturnType<typeof initializeDatabase>;
  sqsClient: ReturnType<typeof initializeSQS>;
  server: Server;
}

async function main() {
  console.log('[STARTUP] Starting ingestion-service...');

  const context: Partial<StartupContext> = {};

  try {
    // Step 1: Load configuration
    console.log('[STARTUP] Step 1: Loading configuration...');
    context.config = loadConfig();
    console.log('[STARTUP] ✓ Configuration loaded successfully', {
      port: context.config.port,
      databaseUrl: context.config.database.url ? 'configured' : 'missing',
      sqsEndpoint: context.config.sqs.endpoint || 'AWS default',
      sqsRegion: context.config.sqs.region,
    });

    // Step 2: Connect to Postgres
    console.log('[STARTUP] Step 2: Connecting to PostgreSQL...');
    context.pool = initializeDatabase(context.config.database);
    const dbConnected = await testConnection(context.pool);
    if (!dbConnected) {
      throw new Error('Database connection test failed');
    }
    console.log('[STARTUP] ✓ PostgreSQL connected successfully');

    // Step 3 (Part A): Initialize SQS Client
    // We moved this UP because we need the client ready for the HTTP route below
    console.log('[STARTUP] Step 3a: Initializing SQS Client...');
    context.sqsClient = initializeSQS(context.config.sqs);
    console.log('[STARTUP] ✓ SQS Client initialized');

    // Step 3 (Part B): Start Express server & Define Routes
    console.log('[STARTUP] Step 3b: Starting Express server...');
    const app = createServer();

    // --- NEW: THE INGESTION TRIGGER ---
    app.post('/ingest/manual', async (req: Request, res: Response) => {
      if (!context.sqsClient || !context.pool) {
        res.status(503).json({ error: 'System not ready (DB or SQS missing)' });
        return;
      }

      try {
        // 1. Construct Mock Payload (Simulating what we'd get from Aloha)
        // In a real scenario, these come from req.body
        const rawData = {
          alohaAppointmentId: req.body.alohaId || `ALOHA-${Date.now()}`,
          startTime: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
          endTime: new Date(Date.now() + 90000000).toISOString(),
          serviceType: 'ABA Therapy',
          location: '123 Family Lane, Seattle, WA',
          client: {
            alohaId: 'CLI-001',
            name: 'Alice Family',
            phone: '+15550100',
            address: '123 Family Lane, Seattle, WA'
          },
          caregiver: {
            alohaId: 'CG-001',
            name: 'Bob Caregiver',
            phone: '+15550200',
            email: 'bob@example.com'
          }
        };

        console.log(`[INGEST] 📥 Received data for ${rawData.alohaAppointmentId}`);

        // 2. SAVE TO DB (The new step!)
        // This returns the internal UUID (e.g., "a0eebc99-9c0b...")
        const internalId = await upsertAppointment(context.pool, rawData);
        console.log(`[DB] ✅ Persisted Appointment. UUID: ${internalId}`);

        // 3. Publish Event (Using Internal UUID)
        const event: ReadinessEvaluationEvent = {
          messageId: `msg-${Date.now()}`,
          appointmentId: internalId, // <--- NOW USING REAL DB UUID
          trigger: 'INGESTION',
          timestamp: new Date().toISOString(),
          payload: {
            clientName: rawData.client.name,
            serviceType: rawData.serviceType,
            startTime: rawData.startTime
          }
        };

        await publishMessage(context.sqsClient, 'readiness-evaluation-queue', event);
        
        res.json({ status: 'ingested', internalId, event });
      } catch (error) {
        console.error('[API] Failed to ingest event:', error);
        res.status(500).json({ error: 'Failed to ingest event' });
      }
    });
    // ----------------------------------

    context.server = app.listen(context.config.port);
    
    await new Promise<void>((resolve, reject) => {
      context.server.on('listening', () => {
        console.log('[STARTUP] ✓ Express server started successfully', {
          port: context.config.port,
          healthEndpoint: `http://localhost:${context.config.port}/health`,
          ingestEndpoint: `http://localhost:${context.config.port}/ingest/manual` // <--- NEW Log
        });
        resolve();
      });
      context.server.on('error', (error: Error) => {
        reject(error);
      });
    });

    // Step 4: Consumers (Optional for Ingestion Service)
    // If Ingestion Service eventually LISTENS to things, uncomment this.
    // await initializeConsumers(context.sqsClient);

    console.log('[STARTUP] ✓ Service startup complete - ingestion-service is ready');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);

      if (context.server) {
        await new Promise<void>((resolve) => {
          context.server.close(() => {
            console.log('[SHUTDOWN] ✓ HTTP server closed');
            resolve();
          });
        });
      }

      await closeDatabase();
      console.log('[SHUTDOWN] ✓ Database connections closed');

      console.log('[SHUTDOWN] ✓ Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[ERROR] Unhandled Rejection:', {
        promise: String(promise),
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });

    process.on('uncaughtException', (error) => {
      console.error('[ERROR] Uncaught Exception:', {
        message: error.message,
        stack: error.stack,
      });
      shutdown('uncaughtException');
    });
  } catch (error) {
    console.error('[STARTUP] ✗ Startup failed:', {
      step: getFailedStep(error),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

function getFailedStep(error: any): string {
  if (error?.message?.includes('DATABASE_URL') || error?.message?.includes('database')) {
    return 'Step 1: Configuration';
  }
  if (error?.message?.includes('connection') || error?.message?.includes('PostgreSQL')) {
    return 'Step 2: PostgreSQL connection';
  }
  if (error?.message?.includes('port') || error?.message?.includes('listen')) {
    return 'Step 3: Express server';
  }
  if (error?.message?.includes('SQS') || error?.message?.includes('queue')) {
    return 'Step 4: SQS consumers';
  }
  return 'Unknown step';
}

main().catch((error) => {
  console.error('[STARTUP] ✗ Fatal error during startup:', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});