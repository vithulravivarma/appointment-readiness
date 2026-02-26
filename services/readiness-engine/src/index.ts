import { Server } from 'http';
import { loadConfig } from './config';
import { initializeDatabase, testConnection, closeDatabase } from './db';
import { initializeSQS } from './sqs';
import { createServer } from './server';
import { initializeConsumers } from './handlers';

interface StartupContext {
  config: ReturnType<typeof loadConfig>;
  pool: ReturnType<typeof initializeDatabase>;
  sqsClient: ReturnType<typeof initializeSQS>;
  server: Server;
}

async function main() {
  console.log('[STARTUP] Starting readiness-engine service...');

  const context: Partial<StartupContext> = {};

  try {
    // Step 1: Load configuration
    console.log('[STARTUP] Step 1: Loading configuration...');
    context.config = loadConfig();
    const config = context.config;
    console.log('[STARTUP] ✓ Configuration loaded successfully', {
      port: config.port,
      databaseUrl: config.database.url ? 'configured' : 'missing',
      sqsEndpoint: config.sqs.endpoint || 'AWS default',
      sqsRegion: config.sqs.region,
    });

    // Step 2: Connect to Postgres
    console.log('[STARTUP] Step 2: Connecting to PostgreSQL...');
    context.pool = initializeDatabase(config.database);
    const dbConnected = await testConnection(context.pool);
    if (!dbConnected) {
      throw new Error('Database connection test failed');
    }
    console.log('[STARTUP] ✓ PostgreSQL connected successfully');

    // Step 3: Start Express server
    console.log('[STARTUP] Step 3: Starting Express server...');
    const app = createServer();
    const server = app.listen(config.port);
    context.server = server;
    await new Promise<void>((resolve, reject) => {
      server.on('listening', () => {
        console.log('[STARTUP] ✓ Express server started successfully', {
          port: config.port,
          healthEndpoint: `http://localhost:${config.port}/health`,
        });
        resolve();
      });
      server.on('error', (error: Error) => {
        reject(error);
      });
    });

    // Step 4: Initialize SQS consumers
    console.log('[STARTUP] Step 4: Initializing SQS consumers...');
    context.sqsClient = initializeSQS(config.sqs);
    
    // PASS THE POOL HERE vvv
    await initializeConsumers(context.sqsClient, context.pool!); 
    
    console.log('[STARTUP] ✓ SQS consumers started');

    console.log('[STARTUP] ✓ Service startup complete - readiness-engine is ready');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);

      const serverRef = context.server;
      if (serverRef) {
        await new Promise<void>((resolve) => {
          serverRef.close(() => {
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
  // This is a simple heuristic - in a real system you might track the step explicitly
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
