import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { loadConfig } from './config';
import { initializeDatabase, testConnection, closeDatabase } from './db';
import { initializeSQS, publishMessage } from './sqs';
import { createServer } from './server';
import { upsertAppointment, IngestionPayload } from './repository';
import { QUEUES, ReadinessEvaluationEvent } from '@ar/types';
import { ExcelIngestionSource } from './sources/excel-source';
import { IngestionSource } from './sources/types';

interface StartupContext {
  config: ReturnType<typeof loadConfig>;
  pool: ReturnType<typeof initializeDatabase>;
  sqsClient: ReturnType<typeof initializeSQS>;
  server: Server;
}

const DEFAULT_APPOINTMENT_FILE = 'Appointment List_20260205031742.xlsx';
const DEFAULT_CLIENT_FILE = 'Appointment Billing Info_202602.xlsx';
const DEFAULT_STAFF_FILE = 'Staff List_20260220110549.xlsx';
const BUSINESS_TIME_ZONE = 'America/Los_Angeles';

interface SimulatedTemplateRow {
  appointment_id: string;
  aloha_appointment_id: string | null;
  start_time: string;
  end_time: string;
  service_type: string | null;
  location_address: string | null;
  aloha_client_id: string | null;
  client_name: string;
  primary_phone: string | null;
  service_address: string | null;
  aloha_caregiver_id: string | null;
  caregiver_name: string;
  caregiver_phone: string | null;
  caregiver_email: string | null;
}

interface SimulationRunResult {
  simulatedToday: string;
  targetDate: string;
  attempted: number;
  ingested: number;
  failed: number;
  internalIds: string[];
  failures: Array<{ appointmentId: string; message: string }>;
}

const ingestionSimulation = {
  running: false,
  intervalMs: 86_400_000,
  subsetSize: 3,
  simulatedToday: getBusinessDateString(new Date()),
  lastRunAt: null as string | null,
  lastResult: null as SimulationRunResult | null,
  timer: null as NodeJS.Timeout | null,
  inFlight: false,
};

async function main() {
  console.log('[STARTUP] Starting ingestion-service...');

  const context: Partial<StartupContext> = {};

  try {
    context.config = loadConfig();
    context.pool = initializeDatabase(context.config.database);

    const dbConnected = await testConnection(context.pool);
    if (!dbConnected) {
      throw new Error('Database connection test failed');
    }

    context.sqsClient = initializeSQS(context.config.sqs);
    const app = createServer();

    app.post('/ingest/manual', async (req: Request, res: Response) => {
      if (!context.sqsClient || !context.pool) {
        res.status(503).json({ error: 'System not ready (DB or SQS missing)' });
        return;
      }

      try {
        const rawData: IngestionPayload = {
          alohaAppointmentId: req.body.alohaId || `ALOHA-${Date.now()}`,
          startTime: new Date(Date.now() + 86400000).toISOString(),
          endTime: new Date(Date.now() + 90000000).toISOString(),
          serviceType: 'ABA Therapy',
          location: '123 Family Lane, Seattle, WA',
          client: {
            alohaId: 'CLI-001',
            name: 'Alice Family',
            phone: '+15550100',
            address: '123 Family Lane, Seattle, WA',
          },
          caregiver: {
            alohaId: 'CG-001',
            name: 'Bob Caregiver',
            phone: '+15550200',
            email: 'bob@example.com',
          },
        };

        const internalId = await upsertAppointment(context.pool, rawData);
        await publishReadinessEvent(context.sqsClient, internalId, rawData);

        res.json({ status: 'ingested', internalId });
      } catch (error) {
        console.error('[API] Failed to ingest manual event:', error);
        res.status(500).json({ error: 'Failed to ingest event' });
      }
    });

    app.post('/ingest/excel', async (req: Request, res: Response) => {
      if (!context.sqsClient || !context.pool) {
        res.status(503).json({ error: 'System not ready (DB or SQS missing)' });
        return;
      }

      try {
        const source = createExcelSource(req.body || {});
        const batch = await source.load();

        let successCount = 0;
        const failures: Array<{ appointmentId: string; message: string }> = [];

        for (const payload of batch.appointments) {
          try {
            const internalId = await upsertAppointment(context.pool, payload);
            await publishReadinessEvent(context.sqsClient, internalId, payload);
            successCount += 1;
          } catch (error) {
            failures.push({
              appointmentId: payload.alohaAppointmentId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const accountRes = await context.pool.query(
          `
            SELECT role, username, display_name
            FROM auth_users
            ORDER BY role, display_name
          `,
        );

        res.json({
          status: 'ingested',
          summary: {
            attempted: batch.appointments.length,
            success: successCount,
            failed: failures.length,
          },
          metadata: batch.metadata,
          failures: failures.slice(0, 20),
          authAccounts: accountRes.rows,
          testPassword: 'demo123',
        });
      } catch (error) {
        console.error('[API] Failed to ingest excel data:', error);
        res.status(500).json({ error: 'Failed to ingest excel data' });
      }
    });

    app.post('/ingest/simulate/day', async (req: Request, res: Response) => {
      if (!context.sqsClient || !context.pool) {
        res.status(503).json({ error: 'System not ready (DB or SQS missing)' });
        return;
      }

      try {
        const simulatedToday = coerceDateInput(req.body?.simulatedToday);
        const subsetSize = coerceSubsetSize(req.body?.subsetSize, ingestionSimulation.subsetSize);
        const result = await runSimulationDay(context.pool, context.sqsClient, { simulatedToday, subsetSize });
        ingestionSimulation.lastRunAt = new Date().toISOString();
        ingestionSimulation.lastResult = result;

        res.json({
          status: 'simulated',
          ...result,
          nextSimulatedToday: addDays(simulatedToday, 1),
        });
      } catch (error) {
        console.error('[API] Failed simulate/day run:', error);
        res.status(500).json({ error: 'Failed to run simulated ingestion day' });
      }
    });

    app.post('/ingest/simulate/start', async (req: Request, res: Response) => {
      if (!context.sqsClient || !context.pool) {
        res.status(503).json({ error: 'System not ready (DB or SQS missing)' });
        return;
      }
      if (ingestionSimulation.running) {
        res.status(409).json({ error: 'Simulation is already running', state: getSimulationState() });
        return;
      }

      ingestionSimulation.simulatedToday = coerceDateInput(req.body?.simulatedToday);
      ingestionSimulation.subsetSize = coerceSubsetSize(req.body?.subsetSize, ingestionSimulation.subsetSize);
      ingestionSimulation.intervalMs = coerceIntervalMs(req.body?.intervalMs, ingestionSimulation.intervalMs);
      ingestionSimulation.running = true;

      const runTick = async () => {
        if (!context.pool || !context.sqsClient || ingestionSimulation.inFlight) {
          return;
        }
        ingestionSimulation.inFlight = true;
        try {
          const result = await runSimulationDay(context.pool, context.sqsClient, {
            simulatedToday: ingestionSimulation.simulatedToday,
            subsetSize: ingestionSimulation.subsetSize,
          });
          ingestionSimulation.lastRunAt = new Date().toISOString();
          ingestionSimulation.lastResult = result;
          ingestionSimulation.simulatedToday = addDays(ingestionSimulation.simulatedToday, 1);
        } catch (error) {
          console.error('[SIM] Tick failed', error);
        } finally {
          ingestionSimulation.inFlight = false;
        }
      };

      await runTick();
      ingestionSimulation.timer = setInterval(() => {
        void runTick();
      }, ingestionSimulation.intervalMs);
      ingestionSimulation.timer.unref();

      res.json({
        status: 'started',
        state: getSimulationState(),
      });
    });

    app.post('/ingest/simulate/stop', (_req: Request, res: Response) => {
      stopSimulationTimer();
      res.json({
        status: 'stopped',
        state: getSimulationState(),
      });
    });

    app.get('/ingest/simulate/status', (_req: Request, res: Response) => {
      res.json(getSimulationState());
    });

    context.server = app.listen(context.config.port);

    await new Promise<void>((resolve, reject) => {
      context.server?.on('listening', resolve);
      context.server?.on('error', reject);
    });

    console.log('[STARTUP] ✓ ingestion-service ready', {
      port: context.config.port,
      manualEndpoint: `http://localhost:${context.config.port}/ingest/manual`,
      excelEndpoint: `http://localhost:${context.config.port}/ingest/excel`,
      simulationEndpoints: [
        `POST http://localhost:${context.config.port}/ingest/simulate/day`,
        `POST http://localhost:${context.config.port}/ingest/simulate/start`,
        `POST http://localhost:${context.config.port}/ingest/simulate/stop`,
        `GET http://localhost:${context.config.port}/ingest/simulate/status`,
      ],
    });

    const shutdown = async (signal: string) => {
      console.log(`[SHUTDOWN] Received ${signal}, shutting down...`);

      if (context.server) {
        await new Promise<void>((resolve) => {
          context.server?.close(() => resolve());
        });
      }
      stopSimulationTimer();

      await closeDatabase();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('[STARTUP] ✗ Startup failed:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

function stopSimulationTimer(): void {
  if (ingestionSimulation.timer) {
    clearInterval(ingestionSimulation.timer);
    ingestionSimulation.timer = null;
  }
  ingestionSimulation.running = false;
  ingestionSimulation.inFlight = false;
}

function getSimulationState() {
  return {
    running: ingestionSimulation.running,
    intervalMs: ingestionSimulation.intervalMs,
    subsetSize: ingestionSimulation.subsetSize,
    simulatedToday: ingestionSimulation.simulatedToday,
    lastRunAt: ingestionSimulation.lastRunAt,
    lastResult: ingestionSimulation.lastResult,
  };
}

function createExcelSource(body: Record<string, unknown>): IngestionSource {
  const appointmentsFile = resolveInputPath(
    typeof body.appointmentsFile === 'string' ? body.appointmentsFile : DEFAULT_APPOINTMENT_FILE,
  );
  const clientFile = resolveInputPath(
    typeof body.clientFile === 'string'
      ? body.clientFile
      : typeof body.billingFile === 'string'
        ? body.billingFile
        : DEFAULT_CLIENT_FILE,
  );
  const staffFile =
    typeof body.staffFile === 'string'
      ? resolveInputPath(body.staffFile)
      : resolveOptionalInputPath(DEFAULT_STAFF_FILE);

  return new ExcelIngestionSource({ appointmentsFile, clientFile, staffFile });
}

function resolveInputPath(input: string): string {
  if (path.isAbsolute(input)) {
    return input;
  }

  const localPath = path.resolve(process.cwd(), input);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  return path.resolve(process.cwd(), '../../', input);
}

function resolveOptionalInputPath(input: string): string | undefined {
  if (path.isAbsolute(input)) {
    return fs.existsSync(input) ? input : undefined;
  }

  const localPath = path.resolve(process.cwd(), input);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const repoRootPath = path.resolve(process.cwd(), '../../', input);
  if (fs.existsSync(repoRootPath)) {
    return repoRootPath;
  }

  return undefined;
}

async function publishReadinessEvent(
  sqsClient: ReturnType<typeof initializeSQS>,
  appointmentId: string,
  payload: IngestionPayload,
): Promise<void> {
  const event: ReadinessEvaluationEvent = {
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    appointmentId,
    trigger: 'INGESTION',
    timestamp: new Date().toISOString(),
    payload: {
      clientName: payload.client.name,
      serviceType: payload.serviceType,
      startTime: payload.startTime,
    },
  };

  await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, event);
}

async function runSimulationDay(
  pool: ReturnType<typeof initializeDatabase>,
  sqsClient: ReturnType<typeof initializeSQS>,
  input: { simulatedToday: string; subsetSize: number },
): Promise<SimulationRunResult> {
  const templates = await loadSimulationTemplates(pool, input.subsetSize);
  if (templates.length === 0) {
    throw new Error('No appointment templates found to simulate from');
  }

  const targetDate = addDays(input.simulatedToday, 1);
  const failures: Array<{ appointmentId: string; message: string }> = [];
  const internalIds: string[] = [];

  for (const row of templates) {
    try {
      const payload = cloneTemplateToPayload(row, targetDate);
      const internalId = await upsertAppointment(pool, payload);
      await publishReadinessEvent(sqsClient, internalId, payload);
      internalIds.push(internalId);
    } catch (error) {
      failures.push({
        appointmentId: row.aloha_appointment_id || row.appointment_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    simulatedToday: input.simulatedToday,
    targetDate,
    attempted: templates.length,
    ingested: internalIds.length,
    failed: failures.length,
    internalIds,
    failures,
  };
}

async function loadSimulationTemplates(
  pool: ReturnType<typeof initializeDatabase>,
  subsetSize: number,
): Promise<SimulatedTemplateRow[]> {
  const preferred = await pool.query(
    `
      SELECT
        a.id::text AS appointment_id,
        a.aloha_appointment_id,
        a.start_time::text,
        a.end_time::text,
        a.service_type,
        a.location_address,
        c.aloha_client_id,
        c.name AS client_name,
        c.primary_phone,
        c.service_address,
        g.aloha_caregiver_id,
        g.name AS caregiver_name,
        g.phone AS caregiver_phone,
        g.email AS caregiver_email
      FROM appointments a
      INNER JOIN clients c ON c.id = a.client_id
      INNER JOIN caregivers g ON g.id = a.caregiver_id
      WHERE a.aloha_appointment_id IS NULL OR a.aloha_appointment_id NOT LIKE '%-SIM-%'
      ORDER BY a.start_time ASC
      LIMIT $1
    `,
    [subsetSize],
  );
  if (preferred.rows.length > 0) {
    return preferred.rows as SimulatedTemplateRow[];
  }

  const fallback = await pool.query(
    `
      SELECT
        a.id::text AS appointment_id,
        a.aloha_appointment_id,
        a.start_time::text,
        a.end_time::text,
        a.service_type,
        a.location_address,
        c.aloha_client_id,
        c.name AS client_name,
        c.primary_phone,
        c.service_address,
        g.aloha_caregiver_id,
        g.name AS caregiver_name,
        g.phone AS caregiver_phone,
        g.email AS caregiver_email
      FROM appointments a
      INNER JOIN clients c ON c.id = a.client_id
      INNER JOIN caregivers g ON g.id = a.caregiver_id
      ORDER BY a.start_time ASC
      LIMIT $1
    `,
    [subsetSize],
  );

  return fallback.rows as SimulatedTemplateRow[];
}

function cloneTemplateToPayload(row: SimulatedTemplateRow, targetDate: string): IngestionPayload {
  const startTime = setDateKeepUtcClock(row.start_time, targetDate);
  const durationMs = new Date(row.end_time).getTime() - new Date(row.start_time).getTime();
  const endTime = new Date(new Date(startTime).getTime() + Math.max(durationMs, 30 * 60 * 1000)).toISOString();

  const baseId = row.aloha_appointment_id || `APPT-${row.appointment_id.slice(0, 8)}`;
  const alohaAppointmentId = `${baseId}-SIM-${targetDate}`;

  return {
    alohaAppointmentId,
    startTime,
    endTime,
    serviceType: row.service_type || 'ABA Therapy',
    location: row.location_address || row.service_address || 'TBD',
    client: {
      alohaId: row.aloha_client_id || `CLI-${row.appointment_id.slice(0, 8)}`,
      name: row.client_name,
      phone: row.primary_phone || undefined,
      address: row.service_address || row.location_address || undefined,
    },
    caregiver: {
      alohaId: row.aloha_caregiver_id || `CG-${row.appointment_id.slice(0, 8)}`,
      name: row.caregiver_name,
      phone: row.caregiver_phone || undefined,
      email: row.caregiver_email || undefined,
    },
  };
}

function setDateKeepUtcClock(sourceIso: string, targetDate: string): string {
  const source = new Date(sourceIso);
  const [y, m, d] = targetDate.split('-').map((v) => parseInt(v, 10));
  const target = new Date(Date.UTC(y, m - 1, d, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds()));
  return target.toISOString();
}

function coerceDateInput(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return getBusinessDateString(new Date());
}

function coerceSubsetSize(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(25, parsed));
}

function coerceIntervalMs(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(10_000, parsed);
}

function getBusinessDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error('[STARTUP] ✗ Fatal error during startup:', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
