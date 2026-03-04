import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg'; 
import {
  QUEUES,
  ReadinessEvaluationEvent,
  NotificationJob,
  resolvePrecheckProfile,
  type PrecheckCheckType,
} from '@ar/types';
import { NonRetryableMessageError, subscribeToQueue, publishMessage } from './sqs';
// Make sure updateCheckStatus is imported from your repository
import { ensureChecklistExists, getReadinessState, updateReadinessStatus, updateCheckStatus } from './repository';
import { evaluateReadiness } from './logic';
import {
  buildPersistentIdempotencyKey,
  hasPersistentProcessedMessage,
  markPersistentProcessedMessage,
} from './idempotency-store';

// Define the shape of the message coming from Phase 3 AI
interface AIUpdateEvent {
  type: 'UPDATE_CHECK';
  appointmentId: string;
  checkType: string;
  status: 'PASS' | 'FAIL';
  source: string;
}

interface PrecheckCandidate {
  appointmentId: string;
  caregiverId: string;
  clientName: string;
  startTime: string;
  serviceType: string | null;
}
const BUSINESS_TIME_ZONE = 'America/Los_Angeles';
const READINESS_EVALUATION_CONSUMER = 'readiness-engine.readiness-evaluation';
const READINESS_UPDATES_CONSUMER = 'readiness-engine.readiness-updates';

export async function handleReadinessEvaluation(
  message: Message, 
  sqsClient: SQSClient,
  pool: Pool 
): Promise<void> {
  if (!message.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }
  let event: ReadinessEvaluationEvent;
  try {
    event = JSON.parse(message.Body) as ReadinessEvaluationEvent;
  } catch {
    throw new NonRetryableMessageError('Invalid JSON for readiness evaluation event', 'INVALID_JSON');
  }
  if (!String(event?.appointmentId || '').trim()) {
    throw new NonRetryableMessageError('Readiness evaluation event missing appointmentId', 'MISSING_APPOINTMENT_ID');
  }
  const key = buildPersistentIdempotencyKey(READINESS_EVALUATION_CONSUMER, QUEUES.READINESS_EVALUATION, message);
  if (!key) {
    throw new NonRetryableMessageError('Readiness evaluation event missing MessageId', 'MISSING_MESSAGE_ID');
  }
  if (await hasPersistentProcessedMessage(pool, key)) {
    console.log('[HANDLER] Skipping duplicate readiness evaluation event via persistent idempotency key', {
      appointmentId: event.appointmentId,
      messageId: message.MessageId,
    });
    return;
  }

  console.log(`[HANDLER] Processing ${event.appointmentId} (Trigger: ${event.trigger})`);

  // 1. Ensure checks exist
  await ensureChecklistExists(pool, event.appointmentId);

  // 2. Get current state
  const currentState = await getReadinessState(pool, event.appointmentId);

  // 3. Run rules
  const result = evaluateReadiness(currentState);

  // 4. Save result if changed
  if (result.nextStatus !== currentState.status) {
    await updateReadinessStatus(pool, event.appointmentId, result.nextStatus, result.riskScore);
    console.log(`[DB] Updated status to ${result.nextStatus}`);
  }

  // 5. Notify
  if (result.shouldNotify) {
    const notification: NotificationJob = {
      type: 'SMS',
      recipient: '+15550000000',
      templateId: result.nextStatus === 'BLOCKED' ? 'ESCALATION_ALERT' : 'READY_CONFIRMATION',
      data: { appointmentId: event.appointmentId, status: result.nextStatus }
    };
    await publishMessage(sqsClient, QUEUES.NOTIFICATION, notification);
  }

  await kickoffPendingPrecheckConversations(pool);
  await markPersistentProcessedMessage(pool, key, 'SUCCEEDED', {
    appointmentId: event.appointmentId,
    trigger: event.trigger,
  });
}

// --- INITIALIZATION ---
export async function initializeConsumers(sqsClient: SQSClient, pool: Pool): Promise<void> {
  // 1. Phase 1: Periodic/Triggered Evaluations
  await subscribeToQueue(sqsClient, QUEUES.READINESS_EVALUATION, (msg) => 
    handleReadinessEvaluation(msg, sqsClient, pool)
  );

  // 2. Phase 3: AI Chat Updates
  // We updated the queue name to match what we created in LocalStack today
  await subscribeToQueue(sqsClient, QUEUES.READINESS_UPDATES, (msg) => 
    handleAISignal(msg, sqsClient, pool)
  );

  // Event-driven kickoff scan: ingestion/lifecycle/AI update events trigger this.
  await kickoffPendingPrecheckConversations(pool);
  
  console.log('[HANDLERS] Consumers initialized', {
    queues: [QUEUES.READINESS_EVALUATION, QUEUES.READINESS_UPDATES],
    precheckMode: 'event-driven',
  });
}

// --- PHASE 3 HANDLER (Updated for Chat Workflow) ---
export async function handleAISignal(message: Message, sqsClient: SQSClient, pool: Pool): Promise<void> {
  if (!message.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }
  let body: any;
  try {
    body = JSON.parse(message.Body);
  } catch {
    throw new NonRetryableMessageError('Invalid JSON for AI signal event', 'INVALID_JSON');
  }
  const key = buildPersistentIdempotencyKey(READINESS_UPDATES_CONSUMER, QUEUES.READINESS_UPDATES, message);
  if (!key) {
    throw new NonRetryableMessageError('AI signal event missing MessageId', 'MISSING_MESSAGE_ID');
  }
  if (await hasPersistentProcessedMessage(pool, key)) {
    console.log('[HANDLERS] Skipping duplicate AI signal via persistent idempotency key', {
      messageId: message.MessageId,
    });
    return;
  }
  
  // We only care about the specific UPDATE_CHECK event from the AI
  if (body.type !== 'UPDATE_CHECK') {
    console.log(`[HANDLERS] Ignored unknown event type: ${String(body.type || 'unknown')}`);
    await markPersistentProcessedMessage(pool, key, 'SUCCEEDED', {
      ignoredType: String(body.type || 'unknown'),
    });
    return;
  }

  const event = body as AIUpdateEvent;
  if (!String(event.appointmentId || '').trim()) {
    throw new NonRetryableMessageError('AI signal missing appointmentId', 'MISSING_APPOINTMENT_ID');
  }
  if (!String(event.checkType || '').trim()) {
    throw new NonRetryableMessageError('AI signal missing checkType', 'MISSING_CHECK_TYPE');
  }
  if (event.status !== 'PASS' && event.status !== 'FAIL') {
    throw new NonRetryableMessageError('AI signal status must be PASS or FAIL', 'INVALID_STATUS');
  }

  console.log(`[HANDLERS] 🤖 AI Update: Setting ${event.checkType} to ${event.status} for ${event.appointmentId}`);

  // Ensure rows exist before applying AI updates to avoid dropped updates.
  await ensureChecklistExists(pool, event.appointmentId);

  // 1. DB: Update the specific check (e.g., ACCESS_CODE)
  // This is more precise than resolving *all* checks
  await updateCheckStatus(pool, event.appointmentId, event.checkType, event.status);

  // 2. DB: Get the new state (refresh everything)
  const newState = await getReadinessState(pool, event.appointmentId);

  // 3. LOGIC: Re-evaluate the Score (Does this specific fix make the whole appt READY?)
  const result = evaluateReadiness(newState);

  // 4. DB: Update the parent status if it changed
  if (result.nextStatus !== newState.status) {
    await updateReadinessStatus(pool, event.appointmentId, result.nextStatus, result.riskScore);
    console.log(`[DB] 🔄 State transition: ${newState.status} -> ${result.nextStatus}`);

    // 5. NOTIFY: If we just turned Green
    if (result.nextStatus === 'READY') {
      const notification: NotificationJob = {
        type: 'SMS',
        recipient: '+15550000000',
        templateId: 'READY_CONFIRMATION',
        data: { appointmentId: event.appointmentId, status: 'READY' }
      };
      await publishMessage(sqsClient, QUEUES.NOTIFICATION, notification);
    }
  }

  await kickoffPendingPrecheckConversations(pool);
  await markPersistentProcessedMessage(pool, key, 'SUCCEEDED', {
    appointmentId: event.appointmentId,
    checkType: event.checkType,
    status: event.status,
  });
}

async function kickoffPendingPrecheckConversations(pool: Pool): Promise<void> {
  const batchSizeRaw = Number(process.env.PRECHECK_KICKOFF_BATCH_SIZE || '100');
  const batchSize = Number.isFinite(batchSizeRaw)
    ? Math.max(1, Math.min(500, Math.trunc(batchSizeRaw)))
    : 100;

  const maxCyclesRaw = Number(process.env.PRECHECK_KICKOFF_MAX_CYCLES || '20');
  const maxCycles = Number.isFinite(maxCyclesRaw)
    ? Math.max(1, Math.min(200, Math.trunc(maxCyclesRaw)))
    : 20;

  let cycle = 0;
  let totalStarted = 0;
  let totalConsidered = 0;

  while (cycle < maxCycles) {
    cycle += 1;
    const candidates = await findPrecheckCandidates(pool, batchSize);
    if (candidates.length === 0) {
      break;
    }

    totalConsidered += candidates.length;
    let startedThisCycle = 0;

    for (const candidate of candidates) {
      try {
        const started = await startPrecheckConversation(pool, candidate);
        if (started) {
          startedThisCycle += 1;
          totalStarted += 1;
          console.log(`[HANDLERS] 💬 Precheck started for ${candidate.appointmentId}`);
        }
      } catch (error) {
        console.error('[HANDLERS] Failed to start precheck conversation', {
          appointmentId: candidate.appointmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Avoid repeatedly scanning the same candidate set if nothing can progress.
    if (startedThisCycle === 0) {
      break;
    }

    // If we did not fill a full batch, there is no larger backlog to drain right now.
    if (candidates.length < batchSize) {
      break;
    }
  }

  if (totalConsidered > 0) {
    console.log('[HANDLERS] Precheck kickoff scan complete', {
      batchSize,
      maxCycles,
      cyclesExecuted: cycle,
      candidatesConsidered: totalConsidered,
      prechecksStarted: totalStarted,
    });
  }
}

async function findPrecheckCandidates(pool: Pool, limit: number): Promise<PrecheckCandidate[]> {
  const res = await pool.query(
    `
      WITH ranked AS (
        SELECT
          a.id,
          a.client_id,
          a.caregiver_id,
          a.start_time,
          a.service_type,
          c.name AS client_name,
          ROW_NUMBER() OVER (
            PARTITION BY a.client_id
            ORDER BY a.start_time ASC, a.id ASC
          ) AS rn
        FROM appointments a
        INNER JOIN clients c ON c.id = a.client_id
        WHERE COALESCE(a.aloha_status, 'SCHEDULED') = 'SCHEDULED'
          AND a.caregiver_id IS NOT NULL
          AND a.start_time > NOW()
      )
      SELECT
        r.id::text AS appointment_id,
        r.caregiver_id::text AS caregiver_id,
        r.client_name,
        r.start_time,
        r.service_type
      FROM ranked r
      WHERE r.rn = 1
        AND NOT EXISTS (
          SELECT 1
          FROM readiness_events re
          WHERE re.appointment_id = r.id
            AND re.event_type = 'PRECHECK_STARTED'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM appointments ap
          WHERE ap.client_id = r.client_id
            AND EXISTS (
              SELECT 1
              FROM readiness_events rs
              WHERE rs.appointment_id = ap.id
                AND rs.event_type = 'PRECHECK_STARTED'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM readiness_events rc
              WHERE rc.appointment_id = ap.id
                AND rc.event_type = 'PRECHECK_COMPLETED'
            )
            AND COALESCE(ap.aloha_status, 'SCHEDULED') IN ('SCHEDULED', 'IN_PROGRESS')
            AND (ap.end_time + INTERVAL '3 hours') > NOW()
        )
      ORDER BY r.start_time ASC
      LIMIT $1
    `,
    [limit],
  );

  return res.rows.map((row) => ({
    appointmentId: String(row.appointment_id),
    caregiverId: String(row.caregiver_id),
    clientName: String(row.client_name),
    startTime: new Date(row.start_time).toISOString(),
    serviceType: row.service_type ? String(row.service_type) : null,
  }));
}

async function startPrecheckConversation(pool: Pool, candidate: PrecheckCandidate): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eventInsert = await client.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        SELECT $1::uuid, 'PRECHECK_STARTED', $2::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM readiness_events
          WHERE appointment_id = $1::uuid
            AND event_type = 'PRECHECK_STARTED'
        )
        RETURNING id
      `,
      [
        candidate.appointmentId,
        JSON.stringify({
          startedBy: 'READINESS_ENGINE',
          startedAt: new Date().toISOString(),
        }),
      ],
    );

    if (eventInsert.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const profile = resolvePrecheckProfile(candidate.serviceType);
    const when = new Date(candidate.startTime).toLocaleString('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    const firstQuestion = profile.questions[0]?.prompt || 'Can you confirm access and readiness details for this appointment?';
    const intro = `Hi ${candidate.clientName}, I'm your care team assistant for your upcoming ${when} visit. First quick pre-readiness check: ${firstQuestion}`;
    const now = new Date();
    const apptStart = new Date(candidate.startTime);
    const delegationEndsAt = apptStart > now
      ? apptStart.toISOString()
      : new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

    await client.query(
      `
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1::uuid, 'AI_AGENT', $2, $3, true)
      `,
      [candidate.appointmentId, candidate.caregiverId, intro],
    );

    // Ensure agent row exists, then lock it to avoid lost updates when multiple
    // precheck kickoffs for the same caregiver happen concurrently.
    await client.query(
      `
        INSERT INTO user_agents (user_id, role, status, paused_until, persona_settings)
        VALUES ($1, 'CAREGIVER', 'ACTIVE', NULL, '{}'::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          role = 'CAREGIVER',
          status = 'ACTIVE',
          paused_until = NULL
      `,
      [candidate.caregiverId],
    );

    const agentRes = await client.query(
      `
        SELECT persona_settings
        FROM user_agents
        WHERE user_id = $1
        FOR UPDATE
      `,
      [candidate.caregiverId],
    );
    const settings = (agentRes.rows[0]?.persona_settings || {}) as any;
    const delegations = { ...(settings.delegations || {}) };
    delegations[candidate.appointmentId] = {
      appointmentId: candidate.appointmentId,
      active: true,
      objective: profile.objective,
      questions: profile.questions.map((q) => q.prompt),
      askedQuestionIndexes: [0],
      startedAt: now.toISOString(),
      endsAt: delegationEndsAt,
      source: 'PRECHECK_AUTOMATION',
      systemManaged: true,
      precheckProfileId: profile.id,
    };

    await client.query(
      `
        UPDATE user_agents
        SET
          role = 'CAREGIVER',
          status = 'ACTIVE',
          paused_until = NULL,
          persona_settings = $2::jsonb
        WHERE user_id = $1
      `,
      [candidate.caregiverId, JSON.stringify({ ...settings, delegations })],
    );

    const plannerSeed = {
      version: 1,
      profileId: profile.id,
      items: profile.questions.reduce((acc, q, idx) => {
        const key = q.checkType as PrecheckCheckType;
        acc[key] = {
          question: q.prompt,
          status: 'PENDING',
          ...(idx === 0 ? { askedAt: new Date().toISOString() } : {}),
        };
        return acc;
      }, {} as Record<PrecheckCheckType, any>),
    };

    await client.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        VALUES ($1::uuid, 'PRECHECK_PLANNER', $2::jsonb)
      `,
      [candidate.appointmentId, JSON.stringify(plannerSeed)],
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
