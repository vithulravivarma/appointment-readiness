// services/ai-interpreter-service/src/handlers.ts
import crypto from 'crypto';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, GetQueueUrlCommand, Message } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import {
  QUEUES,
  getDefaultPrecheckProfile,
  resolvePrecheckProfile,
  type PrecheckCheckType,
} from '@ar/types';
import {
  isSystemManagedDelegationEntry,
  pickForcedQuestion,
  shouldWritePrecheckSummaryToDelegation,
} from './delegation-policy';
import { buildPrecheckCompletionSummary } from './precheck-summary-policy';
import {
  buildPersistentIdempotencyKey,
  hasPersistentProcessedMessage,
  markPersistentProcessedMessage,
} from './idempotency-store';
import {
  evaluateDelegationCompletion,
  formatDelegationProgressUpdate,
  formatDelegationCompletionUpdate,
} from './delegation-completion-policy';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DELEGATION_COMPLETION_NOTIFY_V1 = ['1', 'true', 'yes'].includes(
  String(process.env.ASSISTANT_DELEGATION_COMPLETION_NOTIFY_V1 || 'true').toLowerCase(),
);
const DELEGATION_PROGRESS_NOTIFY_V1 = ['1', 'true', 'yes'].includes(
  String(process.env.ASSISTANT_DELEGATION_PROGRESS_NOTIFY_V1 || 'true').toLowerCase(),
);

type ReadinessPolicy = {
  minConfidence: number;
  requireReasoning: boolean;
};

function loadReadinessPolicy(): ReadinessPolicy {
  const minConfidenceRaw = Number(process.env.READINESS_MIN_CONFIDENCE || '0.75');
  const minConfidence = Number.isFinite(minConfidenceRaw)
    ? Math.max(0, Math.min(1, minConfidenceRaw))
    : 0.75;

  const requireReasoningRaw = String(process.env.READINESS_REQUIRE_REASONING || 'false').toLowerCase();
  const requireReasoning = requireReasoningRaw === '1' || requireReasoningRaw === 'true' || requireReasoningRaw === 'yes';

  return { minConfidence, requireReasoning };
}

const READINESS_POLICY = loadReadinessPolicy();

class NonRetryableMessageError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'NON_RETRYABLE_MESSAGE') {
    super(message);
    this.name = 'NonRetryableMessageError';
    this.code = code;
  }
}

type ConsumerReliabilityOptions = {
  waitTimeSeconds: number;
  pollErrorBackoffMs: number;
  idempotencyTtlMs: number;
  idempotencyMaxKeys: number;
};

const processedMessageCache = new Map<string, number>();

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function loadConsumerReliabilityOptions(): ConsumerReliabilityOptions {
  return {
    waitTimeSeconds: parseIntEnv('SQS_POLL_WAIT_SECONDS', 20, 1, 20),
    pollErrorBackoffMs: parseIntEnv('SQS_POLL_ERROR_BACKOFF_MS', 5000, 250, 60000),
    idempotencyTtlMs: parseIntEnv('SQS_IDEMPOTENCY_TTL_MS', 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    idempotencyMaxKeys: parseIntEnv('SQS_IDEMPOTENCY_MAX_KEYS', 20000, 100, 500000),
  };
}

const CONSUMER_RELIABILITY = loadConsumerReliabilityOptions();
const INCOMING_MESSAGES_CONSUMER = 'ai-interpreter.incoming-messages';

function nowMs(): number {
  return Date.now();
}

function cleanupProcessedMessageCache(ttlMs: number, maxKeys: number): void {
  const cutoff = nowMs() - ttlMs;
  for (const [key, seenAtMs] of processedMessageCache.entries()) {
    if (seenAtMs < cutoff) {
      processedMessageCache.delete(key);
    }
  }

  if (processedMessageCache.size <= maxKeys) return;
  const entries = Array.from(processedMessageCache.entries()).sort((a, b) => a[1] - b[1]);
  const dropCount = processedMessageCache.size - maxKeys;
  for (let i = 0; i < dropCount; i += 1) {
    processedMessageCache.delete(entries[i][0]);
  }
}

function buildIdempotencyKey(queueName: string, message: Message): string {
  const messageId = String(message.MessageId || '').trim() || 'unknown-message-id';
  const bodyHash = crypto
    .createHash('sha1')
    .update(String(message.Body || ''))
    .digest('hex')
    .slice(0, 16);
  return `${queueName}:${messageId}:${bodyHash}`;
}

function hasProcessedRecently(key: string, ttlMs: number): boolean {
  const seenAtMs = processedMessageCache.get(key);
  if (!seenAtMs) return false;
  return nowMs() - seenAtMs <= ttlMs;
}

function rememberProcessed(key: string): void {
  processedMessageCache.set(key, nowMs());
}

function parseReceiveCount(message: Message): number {
  const raw = Number(message.Attributes?.ApproximateReceiveCount || '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.trunc(raw));
}

function isNonRetryableHandlerError(error: unknown): boolean {
  if (error instanceof NonRetryableMessageError) return true;
  if (error instanceof SyntaxError) return true;
  return false;
}

type PlannerCheckType = PrecheckCheckType;
type PlannerStatus = 'PENDING' | 'PASS' | 'FAIL';
type ReadinessCategory = PlannerCheckType | 'CAREGIVER_MATCH_CONFIRMED';

interface ChecklistPlannerItem {
  question: string;
  askedAt?: string;
  answeredAt?: string;
  status: PlannerStatus;
  evidence?: string;
}

interface ChecklistPlannerState {
  version: number;
  profileId?: string;
  items: Record<PlannerCheckType, ChecklistPlannerItem>;
}

const CHECKLIST_ORDER: PlannerCheckType[] = [
  'ACCESS_CONFIRMED',
  'MEDS_SUPPLIES_READY',
  'CARE_PLAN_CURRENT',
];

function createDefaultPlannerState(): ChecklistPlannerState {
  const profile = getDefaultPrecheckProfile();
  const byCheck = new Map(profile.questions.map((q) => [q.checkType, q]));
  return {
    version: 1,
    profileId: profile.id,
    items: {
      ACCESS_CONFIRMED: {
        question: byCheck.get('ACCESS_CONFIRMED')?.prompt || 'Is access confirmed?',
        status: 'PENDING',
      },
      MEDS_SUPPLIES_READY: {
        question: byCheck.get('MEDS_SUPPLIES_READY')?.prompt || 'Are required items ready?',
        status: 'PENDING',
      },
      CARE_PLAN_CURRENT: {
        question: byCheck.get('CARE_PLAN_CURRENT')?.prompt || 'Are visit instructions current?',
        status: 'PENDING',
      },
    },
  };
}

type ReadinessUpdate = {
  category: ReadinessCategory;
  status: 'PASS' | 'FAIL';
  confidence: number;
  reasoning?: string;
};

function normalizeReadinessUpdate(update: any): ReadinessUpdate | null {
  if (!update || typeof update !== 'object') return null;

  const category = String(update.category || '').trim().toUpperCase() as ReadinessCategory;
  const status = String(update.status || '').trim().toUpperCase();
  const confidence = Number(update.confidence);

  const validCategory: ReadinessCategory[] = [
    'ACCESS_CONFIRMED',
    'MEDS_SUPPLIES_READY',
    'CARE_PLAN_CURRENT',
    'CAREGIVER_MATCH_CONFIRMED',
  ];

  if (!validCategory.includes(category)) return null;
  if (status !== 'PASS' && status !== 'FAIL') return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  return {
    category,
    status: status as 'PASS' | 'FAIL',
    confidence,
    reasoning: update.reasoning ? String(update.reasoning) : undefined,
  };
}

function filterReadinessUpdates(
  updates: ReadinessUpdate[],
  options?: {
    allowedCategories?: ReadinessCategory[];
    minConfidence?: number;
    requireReasoning?: boolean;
  },
): ReadinessUpdate[] {
  const minConfidence = Number.isFinite(Number(options?.minConfidence))
    ? Math.max(0, Math.min(1, Number(options?.minConfidence)))
    : 0;
  const requireReasoning = Boolean(options?.requireReasoning);
  const allowedSet = options?.allowedCategories
    ? new Set(options.allowedCategories)
    : null;

  const deduped = new Map<ReadinessCategory, ReadinessUpdate>();
  for (const update of updates) {
    if (update.confidence < minConfidence) continue;
    if (requireReasoning && String(update.reasoning || '').trim().length === 0) continue;
    if (allowedSet && !allowedSet.has(update.category)) continue;
    const existing = deduped.get(update.category);
    if (!existing || update.confidence >= existing.confidence) {
      deduped.set(update.category, update);
    }
  }
  return Array.from(deduped.values());
}

function applyPlannerUpdatesFromReadiness(
  planner: ChecklistPlannerState,
  updates: ReadinessUpdate[],
  evidenceText: string,
): { planner: ChecklistPlannerState; changed: boolean } {
  const next = JSON.parse(JSON.stringify(planner)) as ChecklistPlannerState;
  let changed = false;
  const now = new Date().toISOString();

  for (const update of updates) {
    if (!CHECKLIST_ORDER.includes(update.category as PlannerCheckType)) continue;
    const checkType = update.category as PlannerCheckType;
    const item = next.items[checkType];
    if (!item) continue;
    if (item.status !== update.status || !item.answeredAt) {
      item.status = update.status;
      item.answeredAt = item.answeredAt || now;
      item.evidence = evidenceText.slice(0, 200);
      changed = true;
    }
  }

  return { planner: next, changed };
}

function getNextChecklistQuestion(planner: ChecklistPlannerState): { checkType: PlannerCheckType; question: string } | null {
  for (const checkType of CHECKLIST_ORDER) {
    const item = planner.items[checkType];
    if (!item.answeredAt && !item.askedAt) {
      return { checkType, question: item.question };
    }
  }
  return null;
}

function markChecklistQuestionAsked(
  planner: ChecklistPlannerState,
  checkType: PlannerCheckType,
): ChecklistPlannerState {
  const next = JSON.parse(JSON.stringify(planner)) as ChecklistPlannerState;
  next.items[checkType].askedAt = new Date().toISOString();
  return next;
}

function checklistComplete(planner: ChecklistPlannerState): boolean {
  return CHECKLIST_ORDER.every((checkType) => Boolean(planner.items[checkType].answeredAt));
}

function checklistProgressSummary(planner: ChecklistPlannerState): string {
  return CHECKLIST_ORDER
    .map((checkType) => {
      const item = planner.items[checkType];
      const state = item.answeredAt ? `${item.status} (answered)` : item.askedAt ? 'ASKED' : 'NOT_ASKED';
      return `${checkType}:${state}`;
    })
    .join(' | ');
}

function hydratePlannerState(
  planner: ChecklistPlannerState,
  serviceType?: string | null,
): ChecklistPlannerState {
  const profile = resolvePrecheckProfile(serviceType);
  const byCheck = new Map(profile.questions.map((q) => [q.checkType, q]));
  const next = JSON.parse(JSON.stringify(planner)) as ChecklistPlannerState;
  next.profileId = next.profileId || profile.id;

  for (const checkType of CHECKLIST_ORDER) {
    const mapped = byCheck.get(checkType);
    const existing = next.items[checkType] || {
      question: mapped?.prompt || 'Please confirm readiness for this item.',
      status: 'PENDING' as PlannerStatus,
    };
    next.items[checkType] = {
      ...existing,
      question: existing.question || mapped?.prompt || 'Please confirm readiness for this item.',
    };
  }

  return next;
}

async function loadChecklistPlanner(pool: Pool, appointmentId: string): Promise<ChecklistPlannerState> {
  const res = await pool.query(
    `
      SELECT details
      FROM readiness_events
      WHERE appointment_id = $1::uuid
        AND event_type = 'PRECHECK_PLANNER'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [appointmentId],
  );

  if (res.rows.length === 0) {
    return createDefaultPlannerState();
  }

  const details = res.rows[0].details || {};
  if (!details.items) {
    return createDefaultPlannerState();
  }
  return details as ChecklistPlannerState;
}

async function saveChecklistPlanner(pool: Pool, appointmentId: string, planner: ChecklistPlannerState): Promise<void> {
  await pool.query(
    `
      INSERT INTO readiness_events (appointment_id, event_type, details)
      VALUES ($1::uuid, 'PRECHECK_PLANNER', $2::jsonb)
    `,
    [appointmentId, JSON.stringify(planner)],
  );
}

async function syncPlannerWithReadinessChecks(
  pool: Pool,
  appointmentId: string,
  planner: ChecklistPlannerState,
): Promise<{ planner: ChecklistPlannerState; changed: boolean }> {
  const res = await pool.query(
    `
      SELECT check_type, status
      FROM readiness_checks
      WHERE appointment_id = $1::uuid
        AND check_type = ANY($2::text[])
    `,
    [appointmentId, CHECKLIST_ORDER],
  );

  const next = JSON.parse(JSON.stringify(planner)) as ChecklistPlannerState;
  let changed = false;
  const now = new Date().toISOString();

  for (const row of res.rows) {
    const checkType = String(row.check_type) as PlannerCheckType;
    const status = String(row.status || '').toUpperCase();
    if (!CHECKLIST_ORDER.includes(checkType)) continue;
    if (status !== 'PASS' && status !== 'FAIL') continue;

    const item = next.items[checkType];
    if (item.status !== status || !item.answeredAt) {
      item.status = status as PlannerStatus;
      item.answeredAt = item.answeredAt || now;
      changed = true;
    }
  }

  return { planner: next, changed };
}

async function buildConversationContext(
  pool: Pool,
  appointmentId: string,
  messageId?: string,
): Promise<string> {
  let anchorCreatedAt: string | null = null;
  if (messageId) {
    const anchorRes = await pool.query(
      `
        SELECT created_at::text AS created_at
        FROM messages
        WHERE id = $1::uuid
          AND appointment_id = $2::uuid
        LIMIT 1
      `,
      [messageId, appointmentId],
    );
    anchorCreatedAt = anchorRes.rows[0]?.created_at || null;
  }

  const res = await pool.query(
    `
      SELECT sender_type, content, created_at
      FROM messages
      WHERE appointment_id = $1::uuid
      ${anchorCreatedAt ? `AND created_at <= $2::timestamptz` : ''}
      ORDER BY created_at DESC
      LIMIT 8
    `,
    anchorCreatedAt ? [appointmentId, anchorCreatedAt] : [appointmentId],
  );

  const lines = res.rows
    .reverse()
    .map((row) => `[${String(row.sender_type)}] ${String(row.content).slice(0, 220)}`);
  return lines.join('\n');
}

type DelegationQuestionAssessment = {
  index: number;
  answered: boolean;
  askable: boolean;
  confidence: number;
};

type DelegationQuestionPriority = 'PRIMARY' | 'OPTIONAL';
type DelegationQuestionItem = {
  text: string;
  priority: DelegationQuestionPriority;
};

type NormalizedDelegationQuestions = {
  questions: string[];
  questionItems: DelegationQuestionItem[];
  primaryIndexes: number[];
  optionalIndexes: number[];
};

function normalizeDelegationQuestions(entry: any): NormalizedDelegationQuestions {
  const rawItems: unknown[] = Array.isArray(entry?.questionItems) ? entry.questionItems : [];
  const fromItems: DelegationQuestionItem[] = rawItems
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, unknown>;
      const text = String(item.text || '').trim();
      if (!text) return null;
      const priority = String(item.priority || '').trim().toUpperCase() === 'OPTIONAL' ? 'OPTIONAL' : 'PRIMARY';
      return { text, priority } as DelegationQuestionItem;
    })
    .filter((row): row is DelegationQuestionItem => Boolean(row));
  const rawQuestions: unknown[] = Array.isArray(entry?.questions) ? entry.questions : [];
  const fallback = rawQuestions
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((text) => ({ text, priority: 'PRIMARY' as const }));
  const questionItems = fromItems.length > 0 ? fromItems : fallback;
  const questions = questionItems.map((item) => item.text);
  const rawPrimary = normalizeDelegationIndexList(entry?.primaryQuestionIndexes, questions.length);
  const primaryIndexes = rawPrimary.length > 0
    ? rawPrimary
    : questionItems
        .map((item, idx) => (item.priority === 'PRIMARY' ? idx : -1))
        .filter((idx) => idx >= 0);
  const safePrimaryIndexes = primaryIndexes.length > 0
    ? primaryIndexes
    : (questions.length > 0 ? [0] : []);
  const rawOptional = normalizeDelegationIndexList(entry?.optionalQuestionIndexes, questions.length);
  const optionalIndexes = rawOptional.length > 0
    ? rawOptional
    : questionItems
        .map((item, idx) => (item.priority === 'OPTIONAL' ? idx : -1))
        .filter((idx) => idx >= 0);

  return {
    questions,
    questionItems,
    primaryIndexes: safePrimaryIndexes,
    optionalIndexes,
  };
}

function normalizeDelegationQuestionAssessment(
  raw: any,
  questionCount: number,
): DelegationQuestionAssessment | null {
  if (!raw || typeof raw !== 'object') return null;
  const index = Number(raw.index);
  if (!Number.isInteger(index) || index < 0 || index >= questionCount) return null;
  const answered = Boolean(raw.answered);
  const askable = Boolean(raw.askable);
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  return {
    index,
    answered,
    askable,
    confidence,
  };
}

async function assessDelegationQuestionsWithLLM(input: {
  questions: string[];
  latestMessage: string;
  conversationContext: string;
}): Promise<DelegationQuestionAssessment[] | null> {
  if (!process.env.OPENAI_API_KEY || input.questions.length === 0) {
    return null;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Return valid JSON only.

Assess delegation questions against the latest client-side message.
For each question index provided, determine:
- answered: whether the latest client-side message materially answers the question.
- askable: whether the question is appropriate for a client/family participant to answer.
- confidence: 0 to 1.

Do not use keyword heuristics; infer from semantics and context.
Return:
{
  "assessments": [
    { "index": 0, "answered": false, "askable": true, "confidence": 0.8 }
  ]
}`,
        },
        {
          role: 'user',
          content: [
            `Questions (0-based):`,
            input.questions.map((q, idx) => `${idx}: ${q}`).join('\n'),
            '',
            `Latest message: ${input.latestMessage}`,
            '',
            `Recent conversation:`,
            input.conversationContext || '(none)',
          ].join('\n'),
        },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    const rawAssessments: unknown[] = Array.isArray(parsed?.assessments) ? parsed.assessments : [];
    const normalized = rawAssessments
      .map((item) => normalizeDelegationQuestionAssessment(item, input.questions.length))
      .filter((item): item is DelegationQuestionAssessment => Boolean(item));
    if (normalized.length === 0) return null;
    return normalized;
  } catch (error) {
    console.error('[AI] Delegation assessment failed', error);
    return null;
  }
}

async function isSystemPrecheckActive(pool: Pool, appointmentId: string): Promise<boolean> {
  const res = await pool.query(
    `
      SELECT
        COALESCE(a.aloha_status, 'SCHEDULED') AS status,
        EXISTS (
          SELECT 1
          FROM readiness_events re
          WHERE re.appointment_id = a.id
            AND re.event_type = 'PRECHECK_STARTED'
        ) AS started,
        EXISTS (
          SELECT 1
          FROM readiness_events re
          WHERE re.appointment_id = a.id
            AND re.event_type = 'PRECHECK_COMPLETED'
        ) AS completed
      FROM appointments a
      WHERE a.id = $1::uuid
      LIMIT 1
    `,
    [appointmentId],
  );

  if (res.rows.length === 0) return false;
  const row = res.rows[0];
  return row.status === 'SCHEDULED' && Boolean(row.started) && !Boolean(row.completed);
}

function buildDelegationCompletionDedupeKey(input: {
  appointmentId: string;
  startedAt?: string;
}): string {
  const startedAt = String(input.startedAt || '').trim() || 'unknown-start';
  return `delegation-complete:${input.appointmentId}:${startedAt}`;
}

function buildDelegationProgressDedupeKey(input: {
  appointmentId: string;
  startedAt?: string;
  resolvedPrimaryIndexes: number[];
}): string {
  const startedAt = String(input.startedAt || '').trim() || 'unknown-start';
  const resolved = [...input.resolvedPrimaryIndexes]
    .map((idx) => Number(idx))
    .filter((idx) => Number.isInteger(idx) && idx >= 0)
    .sort((a, b) => a - b)
    .join(',');
  const token = resolved || 'none';
  return `delegation-progress:${input.appointmentId}:${startedAt}:${token}`;
}

function normalizeDelegationIndexList(values: unknown, questionCount: number): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < questionCount)
    .filter((value, idx, arr) => arr.indexOf(value) === idx)
    .sort((a, b) => a - b);
}

let agentDeskSchemaUnavailable = false;
let agentDeskSchemaWarned = false;

function isUndefinedTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as any).code || '').trim();
  if (code === '42P01') return true;
  const message = String((error as any).message || '').toLowerCase();
  return message.includes('does not exist') && message.includes('agent_desk_');
}

function isAgentDeskAppointmentForeignKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as any).code || '').trim();
  if (code !== '23503') return false;
  const constraint = String((error as any).constraint || '').trim();
  if (constraint === 'agent_desk_messages_appointment_id_fkey') return true;
  const message = String((error as any).message || '').toLowerCase();
  return message.includes('agent_desk_messages_appointment_id_fkey');
}

function markAgentDeskSchemaUnavailable(reason: string): void {
  agentDeskSchemaUnavailable = true;
  if (agentDeskSchemaWarned) return;
  agentDeskSchemaWarned = true;
  console.warn('[AI] Agent desk completion notifications disabled because schema is unavailable', {
    reason,
    expectedTables: ['agent_desk_threads', 'agent_desk_messages'],
    recovery: 'Run migrations and restart services.',
  });
}

async function ensureAgentDeskThread(pool: Pool, caregiverId: string): Promise<string | null> {
  if (agentDeskSchemaUnavailable) return null;
  try {
    const existing = await pool.query(
      `
        SELECT id::text
        FROM agent_desk_threads
        WHERE caregiver_id = $1
        LIMIT 1
      `,
      [caregiverId],
    );
    if (existing.rows.length > 0) {
      return String(existing.rows[0].id);
    }

    const inserted = await pool.query(
      `
        INSERT INTO agent_desk_threads (caregiver_id)
        VALUES ($1)
        ON CONFLICT (caregiver_id)
        DO UPDATE SET caregiver_id = EXCLUDED.caregiver_id
        RETURNING id::text
      `,
      [caregiverId],
    );
    return String(inserted.rows[0].id);
  } catch (error) {
    if (isUndefinedTableError(error)) {
      markAgentDeskSchemaUnavailable('ensureAgentDeskThread');
      return null;
    }
    throw error;
  }
}

async function appendAgentDeskDelegationUpdateMessage(input: {
  pool: Pool;
  caregiverId: string;
  appointmentId: string;
  content: string;
  source: 'DELEGATION_PROGRESS' | 'DELEGATION_COMPLETION';
  dedupeKey: string;
  metadata: Record<string, unknown>;
}): Promise<string | null> {
  if (agentDeskSchemaUnavailable) return null;
  const threadId = await ensureAgentDeskThread(input.pool, input.caregiverId);
  if (!threadId) return null;

  const runInsert = async (appointmentIdValue: string | null) => {
    return input.pool.query(
      `
        INSERT INTO agent_desk_messages (
          thread_id,
          appointment_id,
          actor_type,
          content,
          source,
          metadata,
          dedupe_key
        )
        VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4, $5::jsonb, $6)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id::text
      `,
      [threadId, appointmentIdValue, input.content, input.source, JSON.stringify(input.metadata), input.dedupeKey],
    );
  };

  try {
    const result = await (async () => {
      try {
        return await runInsert(input.appointmentId);
      } catch (error) {
        if (!isAgentDeskAppointmentForeignKeyError(error)) {
          throw error;
        }
        console.warn('[AI] Ignoring stale appointment id for agent desk delegation update', {
          caregiverId: input.caregiverId,
          appointmentId: input.appointmentId,
          source: input.source,
        });
        return runInsert(null);
      }
    })();
    if (result.rows.length > 0) {
      return String(result.rows[0].id);
    }
    const existing = await input.pool.query(
      `
        SELECT id::text
        FROM agent_desk_messages
        WHERE dedupe_key = $1
        LIMIT 1
      `,
      [input.dedupeKey],
    );
    return existing.rows[0]?.id ? String(existing.rows[0].id) : null;
  } catch (error) {
    if (isUndefinedTableError(error)) {
      markAgentDeskSchemaUnavailable('appendAgentDeskDelegationUpdateMessage');
      return null;
    }
    throw error;
  }
}

// --- CONSUMER LOOP ---
export async function initializeConsumers(sqs: SQSClient, pool: Pool) {
  console.log('[AI] 🧠 Super-Worker Initialized (Analyst + Agent)...', {
    readinessPolicy: READINESS_POLICY,
    consumerReliability: CONSUMER_RELIABILITY,
    delegationCompletionNotifyV1: DELEGATION_COMPLETION_NOTIFY_V1,
    delegationProgressNotifyV1: DELEGATION_PROGRESS_NOTIFY_V1,
  });
  const [chatQueueUrl, updatesQueueUrl] = await Promise.all([
    getQueueUrl(sqs, QUEUES.INCOMING_MESSAGES),
    getQueueUrl(sqs, QUEUES.READINESS_UPDATES),
  ]);

  pollChatQueue(sqs, pool, chatQueueUrl, updatesQueueUrl).catch(err => {
    console.error('[AI] Fatal Loop Error:', err);
  });
}

async function getQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!response.QueueUrl) {
    throw new Error(`Queue URL not found for queue: ${queueName}`);
  }
  return response.QueueUrl;
}

async function pollChatQueue(sqs: SQSClient, pool: Pool, chatQueueUrl: string, updatesQueueUrl: string) {
  while (true) {
    try {
      cleanupProcessedMessageCache(
        CONSUMER_RELIABILITY.idempotencyTtlMs,
        CONSUMER_RELIABILITY.idempotencyMaxKeys,
      );
      const { Messages } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: chatQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: CONSUMER_RELIABILITY.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));

      if (Messages && Messages.length > 0) {
        for (const msg of Messages) {
          if (!msg.MessageId || !msg.ReceiptHandle) {
            console.warn('[AI] Skipping malformed SQS message without MessageId/ReceiptHandle');
            continue;
          }

          const receiveCount = parseReceiveCount(msg);
          const idempotencyKey = buildIdempotencyKey(QUEUES.INCOMING_MESSAGES, msg);
          if (hasProcessedRecently(idempotencyKey, CONSUMER_RELIABILITY.idempotencyTtlMs)) {
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: chatQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
            console.log('[AI] Duplicate message acknowledged via idempotency cache', {
              messageId: msg.MessageId,
              receiveCount,
            });
            continue;
          }
          const persistentKey = buildPersistentIdempotencyKey(
            INCOMING_MESSAGES_CONSUMER,
            QUEUES.INCOMING_MESSAGES,
            msg,
          );
          if (!persistentKey) {
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: chatQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
            rememberProcessed(idempotencyKey);
            console.warn('[AI] Dropped incoming message with missing MessageId for persistent idempotency', {
              receiveCount,
            });
            continue;
          }
          if (await hasPersistentProcessedMessage(pool, persistentKey)) {
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: chatQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
            rememberProcessed(idempotencyKey);
            console.log('[AI] Duplicate message acknowledged via persistent idempotency store', {
              messageId: msg.MessageId,
              receiveCount,
            });
            continue;
          }

          try {
            await processChatMessage(sqs, pool, msg, updatesQueueUrl);
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: chatQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
            rememberProcessed(idempotencyKey);
            await markPersistentProcessedMessage(pool, persistentKey, 'SUCCEEDED', {
              messageId: msg.MessageId,
            });
          } catch (error) {
            const nonRetryable = isNonRetryableHandlerError(error);
            console.error('[AI] Message processing failed', {
              messageId: msg.MessageId,
              receiveCount,
              retryClass: nonRetryable ? 'NON_RETRYABLE' : 'RETRYABLE',
              error: error instanceof Error ? error.message : String(error),
            });

            if (nonRetryable) {
              await sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: chatQueueUrl,
                  ReceiptHandle: msg.ReceiptHandle,
                }),
              );
              rememberProcessed(idempotencyKey);
              await markPersistentProcessedMessage(pool, persistentKey, 'DROPPED_NON_RETRYABLE', {
                messageId: msg.MessageId,
                errorCode: error instanceof NonRetryableMessageError ? error.code : 'NON_RETRYABLE',
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              console.warn('[AI] Dropped non-retryable incoming message (acked to prevent poison-loop)', {
                messageId: msg.MessageId,
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('[AI] Polling Error:', error);
      await new Promise(resolve => setTimeout(resolve, CONSUMER_RELIABILITY.pollErrorBackoffMs));
    }
  }
}

// --- MAIN PROCESSOR ---
async function processChatMessage(sqs: SQSClient, pool: Pool, msg: Message, updatesQueueUrl: string) {
  if (!msg.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }
  let body: any;
  try {
    body = JSON.parse(msg.Body);
  } catch {
    throw new NonRetryableMessageError('Invalid JSON in incoming message event', 'INVALID_JSON');
  }

  const text = String(body.text || '').trim();
  const appointmentId = String(body.appointmentId || '').trim();
  const senderType = String(body.senderType || '').trim().toUpperCase();
  const messageId = body.messageId ? String(body.messageId) : undefined;

  if (!appointmentId) {
    throw new NonRetryableMessageError('Incoming message missing appointmentId', 'MISSING_APPOINTMENT_ID');
  }
  if (!senderType) {
    throw new NonRetryableMessageError('Incoming message missing senderType', 'MISSING_SENDER_TYPE');
  }
  if (!text) {
    throw new NonRetryableMessageError('Incoming message missing text', 'MISSING_TEXT');
  }

  // IGNORE: Messages sent by the System or the AI itself (Prevent Loops)
  if (senderType === 'SYSTEM' || senderType === 'AI_AGENT') return;
  if (!['CAREGIVER', 'FAMILY', 'COORDINATOR'].includes(senderType)) {
    throw new NonRetryableMessageError(`Unsupported senderType: ${senderType}`, 'INVALID_SENDER_TYPE');
  }

  console.log(`\n[AI] 📨 Processing: "${text}" from ${senderType}`);

  // --- JOB 1: THE READINESS ANALYST ---
  // Run analysis for all human participants so client-side updates can mark checks PASS/FAIL too.
  let readinessUpdates: ReadinessUpdate[] = [];
  if (senderType === 'CAREGIVER' || senderType === 'FAMILY' || senderType === 'COORDINATOR') {
    readinessUpdates = await runReadinessAnalysis(sqs, pool, text, appointmentId, senderType, updatesQueueUrl, messageId);
  }

  // --- JOB 2: Delegated conversation mode ---
  // Caregiver delegation controls whether AI can respond to non-caregiver participants.
  if (senderType === 'FAMILY' || senderType === 'COORDINATOR') {
    await runCaregiverAgent(pool, text, appointmentId, readinessUpdates, messageId);
  }
}

async function classifyReadinessUpdates(
  pool: Pool,
  text: string,
  appointmentId: string,
  senderType: string,
  messageId?: string,
): Promise<ReadinessUpdate[]> {
  const context = await buildConversationContext(pool, appointmentId, messageId);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Output valid JSON only.

Evaluate the latest message for these categories only:
- ACCESS_CONFIRMED
- MEDS_SUPPLIES_READY
- CARE_PLAN_CURRENT
- CAREGIVER_MATCH_CONFIRMED

For each category with sufficient evidence, return:
- category
- status: PASS or FAIL
- confidence: 0 to 1
- reasoning: one concise sentence

Classify from semantics and conversation context, not keyword matching.
If evidence is insufficient for a category, omit it.
If message is unrelated, return {"updates":[]}.

Return shape:
{
  "updates": [
    {
      "category": "ACCESS_CONFIRMED",
      "status": "PASS",
      "confidence": 0.9,
      "reasoning": "..."
    }
  ]
}`,
      },
      { role: 'user', content: `Speaker: ${senderType}\nMessage: ${text}\nRecent conversation:\n${context}` },
    ],
    temperature: 0,
  });

  const content = completion.choices[0].message.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content);
    const rawUpdates: unknown[] = Array.isArray(parsed?.updates) ? parsed.updates : [];
    return rawUpdates
      .map((update: unknown) => normalizeReadinessUpdate(update))
      .filter((update: ReadinessUpdate | null): update is ReadinessUpdate => Boolean(update));
  } catch (error) {
    console.error('[AI] Analysis Parse Error', error);
    return [];
  }
}

// --- SUB-ROUTINE 1: READINESS ANALYSIS ---
async function runReadinessAnalysis(
  sqs: SQSClient,
  pool: Pool,
  text: string,
  appointmentId: string,
  senderType: string,
  updatesQueueUrl: string,
  messageId?: string,
) : Promise<ReadinessUpdate[]> {
  console.log(`[AI] 🔍 Analyzing for logistics updates...`);
  const allUpdates = await classifyReadinessUpdates(pool, text, appointmentId, senderType, messageId);
  const highConfidenceUpdates = filterReadinessUpdates(allUpdates, {
    minConfidence: READINESS_POLICY.minConfidence,
    requireReasoning: READINESS_POLICY.requireReasoning,
  });

  for (const update of highConfidenceUpdates) {
    console.log(`[AI] 🚀 Readiness Update: ${update.category} -> ${update.status}`);
    await sqs.send(new SendMessageCommand({
      QueueUrl: updatesQueueUrl,
      MessageBody: JSON.stringify({
        type: 'UPDATE_CHECK',
        appointmentId,
        checkType: update.category,
        status: update.status,
        source: 'AI_GPT4',
      }),
    }));
  }

  return highConfidenceUpdates;
}

// --- SUB-ROUTINE 2: THE DIGITAL TWIN AGENT (New Logic) ---
async function runCaregiverAgent(
  pool: Pool,
  userText: string,
  appointmentId: string,
  readinessUpdates: ReadinessUpdate[],
  messageId?: string,
) {
  console.log(`[AI] 🤖 Checking if Caregiver Agent should reply...`);

  // 1. Find who the caregiver is and load agent settings
  const apptResult = await pool.query(
    `
      SELECT
        a.caregiver_id,
        a.service_type,
        COALESCE(c.name, 'client') AS client_name
      FROM appointments a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.id = $1::uuid
      LIMIT 1
    `,
    [appointmentId],
  );
  if (apptResult.rows.length === 0) return;
  const caregiverId = String(apptResult.rows[0].caregiver_id);
  const serviceType = apptResult.rows[0].service_type ? String(apptResult.rows[0].service_type) : null;
  const clientName = String(apptResult.rows[0].client_name || 'client');

  // 2. Traffic cop check for global status and delegation window
  const agentResult = await pool.query(
    `SELECT status, persona_settings FROM user_agents WHERE user_id = $1`,
    [caregiverId]
  );
  const status = agentResult.rows[0]?.status || 'ACTIVE';
  const settings = (agentResult.rows[0]?.persona_settings || {}) as any;

  const delegation = settings?.delegations?.[appointmentId];
  const delegationIsSystemManaged = isSystemManagedDelegationEntry(delegation);
  const now = new Date();
  const endsAt = delegation?.endsAt ? new Date(delegation.endsAt) : null;
  let delegationActive = Boolean(delegation?.active);

  if (delegationActive && (!endsAt || now > endsAt)) {
    const updatedSettings = { ...settings };
    updatedSettings.delegations = { ...(updatedSettings.delegations || {}) };
    updatedSettings.delegations[appointmentId] = {
      ...delegation,
      active: false,
      endedAt: now.toISOString(),
    };

    await pool.query(
      `UPDATE user_agents SET persona_settings = $2::jsonb WHERE user_id = $1`,
      [caregiverId, JSON.stringify(updatedSettings)]
    );
    delegationActive = false;
  }

  const precheckActive = await isSystemPrecheckActive(pool, appointmentId);
  if (!delegationActive && !precheckActive) {
    if (status === 'PAUSED') {
      console.log(`[AI] 🛑 Agent BLOCKED: Caregiver ${caregiverId} is PAUSED and no active delegation/precheck.`);
    }
    console.log(`[AI] ⏸️ No active delegation or precheck for appointment ${appointmentId}.`);
    return;
  }

  let planner = await loadChecklistPlanner(pool, appointmentId);
  planner = hydratePlannerState(planner, serviceType);
  const plannerUpdates = filterReadinessUpdates(readinessUpdates, {
    allowedCategories: CHECKLIST_ORDER,
    minConfidence: READINESS_POLICY.minConfidence,
    requireReasoning: READINESS_POLICY.requireReasoning,
  });
  const plannerApplied = applyPlannerUpdatesFromReadiness(planner, plannerUpdates, userText);
  planner = plannerApplied.planner;
  if (plannerApplied.changed) {
    await saveChecklistPlanner(pool, appointmentId, planner);
  }

  const plannerSynced = await syncPlannerWithReadinessChecks(pool, appointmentId, planner);
  planner = plannerSynced.planner;
  if (plannerSynced.changed) {
    await saveChecklistPlanner(pool, appointmentId, planner);
  }

  const objective = String(delegation?.objective || 'Maintain communication and gather logistics updates.');
  const normalizedDelegation = normalizeDelegationQuestions(delegation || {});
  const questions = normalizedDelegation.questions;
  const primaryQuestionIndexes = normalizedDelegation.primaryIndexes;
  const optionalQuestionIndexes = normalizedDelegation.optionalIndexes;
  const delegationTypeRaw = String(
    delegation?.delegationType || delegation?.contextPacket?.delegationType || '',
  )
    .trim()
    .toUpperCase();
  const delegationType: 'FACT_CHECK' | 'LOGISTICS' | 'OPEN_ENDED' =
    delegationTypeRaw === 'FACT_CHECK' || delegationTypeRaw === 'LOGISTICS' || delegationTypeRaw === 'OPEN_ENDED'
      ? delegationTypeRaw
      : 'OPEN_ENDED';
  const askedQuestionIndexes = normalizeDelegationIndexList(delegation?.askedQuestionIndexes, questions.length);
  const alreadyAsked = new Set(askedQuestionIndexes);

  const conversationContext = await buildConversationContext(pool, appointmentId, messageId);
  const delegatedAssessments = await assessDelegationQuestionsWithLLM({
    questions,
    latestMessage: userText,
    conversationContext,
  });

  const ANSWERED_CONFIDENCE_THRESHOLD = 0.6;
  const ASKABLE_CONFIDENCE_THRESHOLD = 0.45;

  const askableQuestions = new Set<number>();
  if (delegatedAssessments && delegatedAssessments.length > 0) {
    for (const assessment of delegatedAssessments) {
      if (assessment.askable && assessment.confidence >= ASKABLE_CONFIDENCE_THRESHOLD) {
        askableQuestions.add(assessment.index);
      }
    }
  } else {
    for (let i = 0; i < questions.length; i += 1) {
      askableQuestions.add(i);
    }
  }

  const answeredByClient = new Set<number>();
  if (delegatedAssessments && delegatedAssessments.length > 0) {
    for (const assessment of delegatedAssessments) {
      if (assessment.answered && assessment.confidence >= ANSWERED_CONFIDENCE_THRESHOLD) {
        answeredByClient.add(assessment.index);
      }
    }
  }

  const completionEvaluation = evaluateDelegationCompletion({
    questions,
    askableIndexes: Array.from(askableQuestions.values()),
    requiredIndexes: primaryQuestionIndexes,
    existingResolvedIndexes: delegation?.resolvedQuestionIndexes,
    answeredIndexes: Array.from(answeredByClient.values()),
    delegationActive,
    delegationIsSystemManaged,
    completionAlreadyNotified: Boolean(delegation?.completionNotifiedAt),
    notifyFlagEnabled: DELEGATION_COMPLETION_NOTIFY_V1,
  });
  const resolvedIndexesSet = new Set<number>(completionEvaluation.resolvedIndexes);
  const primarySet = new Set<number>(primaryQuestionIndexes);
  const optionalSet = new Set<number>(optionalQuestionIndexes);
  const baseUnasked = questions
    .map((_, idx) => idx)
    .filter((idx) => !alreadyAsked.has(idx) && !resolvedIndexesSet.has(idx) && askableQuestions.has(idx));
  const unaskedPrimaryIndexes = baseUnasked.filter((idx) => primarySet.has(idx));
  const unaskedOptionalIndexes = baseUnasked.filter((idx) => optionalSet.has(idx));
  const unaskedIndexes =
    delegationType === 'FACT_CHECK'
      ? unaskedPrimaryIndexes
      : [...unaskedPrimaryIndexes, ...unaskedOptionalIndexes, ...baseUnasked.filter((idx) => !primarySet.has(idx) && !optionalSet.has(idx))];
  const unresolvedRequiredIndexListEarly = completionEvaluation.unresolvedRequiredIndexes;
  const canAskFactCheckClarification =
    delegationType === 'FACT_CHECK' &&
    unresolvedRequiredIndexListEarly.length > 0 &&
    !Boolean((delegation as any)?.factCheckClarificationAsked);
  const clarificationQuestionIndex = canAskFactCheckClarification ? unresolvedRequiredIndexListEarly[0] : null;
  const delegatedNextQuestionIndex = unaskedIndexes.length > 0
    ? unaskedIndexes[0]
    : clarificationQuestionIndex;
  const delegatedNextQuestion =
    delegationActive && delegatedNextQuestionIndex !== null ? questions[delegatedNextQuestionIndex] : null;
  const nextChecklist = getNextChecklistQuestion(planner);
  const forcedQuestion = pickForcedQuestion({
    delegationActive,
    delegationIsSystemManaged,
    delegatedNextQuestion,
    checklistNextQuestion: nextChecklist?.question || null,
  });

  // 3. GENERATE REPLY (Using OpenAI)
  console.log(`[AI] ✅ Agent ACTIVE: Generating reply...`);
  const shouldUseDeterministicAck =
    delegationActive &&
    !delegationIsSystemManaged &&
    delegationType === 'FACT_CHECK' &&
    !forcedQuestion;
  const replyText = shouldUseDeterministicAck
    ? 'Thanks for the update. I have noted it and shared it with your caregiver.'
    : (
        (await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { 
              role: "system", 
              content: `You are the AI delegate for a professional caregiver.
              Conversation mode: ${delegationActive ? 'DELEGATION' : 'SYSTEM_PRECHECK'}
              Delegation type: ${delegationType}
              Delegation objective: ${objective}
              Delegation expires at: ${endsAt ? endsAt.toISOString() : 'N/A'}
              Questions caregiver asked you to collect: ${questions.length > 0 ? questions.join(' | ') : 'None provided'}
              Primary questions to resolve: ${primaryQuestionIndexes.length > 0 ? primaryQuestionIndexes.map((i) => questions[i]).join(' | ') : 'None'}
              Optional questions: ${optionalQuestionIndexes.length > 0 ? optionalQuestionIndexes.map((i) => questions[i]).join(' | ') : 'None'}
              Questions already asked in this delegation: ${askedQuestionIndexes.length > 0 ? askedQuestionIndexes.map((i) => questions[i]).join(' | ') : 'None'}
              Checklist progress: ${checklistProgressSummary(planner)}
              Required next question: ${forcedQuestion || 'None'}
              Rules:
              - Be brief and practical and keep the client informed.
              - Keep replies to at most 2 short sentences and under 45 words.
              - Only discuss logistics and appointment coordination.
              - Reason about who is likely to know each detail before you ask.
              - Avoid asking for details that are normally controlled by the care team rather than the client.
              - Ask at most one question.
              - If "Required next question" is provided, include it exactly once.
              - If "Required next question" is None, do not ask a new question.
              - Do not introduce exploratory questions beyond the listed primary/optional questions.
              - Do not repeat questions that were already asked or already answered.
              - Never give medical advice or emergency guidance.` 
            },
            { role: "user", content: userText },
          ],
          temperature: 0.2,
        })).choices[0].message.content || 'Thanks for the update. I have noted it.'
      );

  // 4. INSERT REPLY INTO DB
  await pool.query(`
    INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
    VALUES ($1, 'AI_AGENT', $2, $3, true)
  `, [appointmentId, caregiverId, replyText]);

  // Persist delegation question progress so we do not keep asking repeats.
  const askedIndexThisTurn =
    delegatedNextQuestion && forcedQuestion === delegatedNextQuestion
      ? delegatedNextQuestionIndex
      : null;
  const askedClarificationThisTurn =
    delegationType === 'FACT_CHECK' &&
    askedIndexThisTurn !== null &&
    alreadyAsked.has(askedIndexThisTurn);
  const resolvedIndexList = completionEvaluation.resolvedIndexes;
  const unresolvedIndexList = completionEvaluation.unresolvedIndexes;
  const requiredResolvedIndexList = completionEvaluation.requiredResolvedIndexes;
  const unresolvedRequiredIndexList = completionEvaluation.unresolvedRequiredIndexes;
  const completionReady = completionEvaluation.shouldNotifyCompletion;
  let completionNotifiedAt: string | undefined;
  let progressMessageId: string | null = null;
  let completionMessageId: string | null = null;
  let progressNotifiedIndexesToPersist: number[] | undefined;

  const previousProgressNotifiedIndexes = normalizeDelegationIndexList(
    delegation?.progressNotifiedIndexes,
    questions.length,
  );
  const previousProgressNotifiedSet = new Set<number>(previousProgressNotifiedIndexes);
  const newlyResolvedPrimaryIndexes = requiredResolvedIndexList.filter((idx) => !previousProgressNotifiedSet.has(idx));
  const shouldNotifyProgress =
    DELEGATION_PROGRESS_NOTIFY_V1 &&
    delegationActive &&
    !delegationIsSystemManaged &&
    !completionReady &&
    newlyResolvedPrimaryIndexes.length > 0;

  if (shouldNotifyProgress) {
    const progressMessage = formatDelegationProgressUpdate({
      clientName,
      questions,
      newlyResolvedIndexes: newlyResolvedPrimaryIndexes,
      unresolvedRequiredIndexes: unresolvedRequiredIndexList,
      latestClientMessage: userText,
    });
    const dedupeKey = buildDelegationProgressDedupeKey({
      appointmentId,
      startedAt: String(delegation?.startedAt || ''),
      resolvedPrimaryIndexes: requiredResolvedIndexList,
    });
    try {
      progressMessageId = await appendAgentDeskDelegationUpdateMessage({
        pool,
        caregiverId,
        appointmentId,
        content: progressMessage,
        source: 'DELEGATION_PROGRESS',
        dedupeKey,
        metadata: {
          appointmentId,
          caregiverId,
          clientName,
          latestClientMessage: userText,
          newlyResolvedPrimaryIndexes,
          unresolvedRequiredIndexes: unresolvedRequiredIndexList,
        },
      });
      if (progressMessageId) {
        progressNotifiedIndexesToPersist = requiredResolvedIndexList;
      }
    } catch (error) {
      console.error('[AI] Failed to write delegation progress update to agent desk', {
        appointmentId,
        caregiverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (completionReady) {
    const completionMessage = formatDelegationCompletionUpdate({
      clientName,
      questions,
      resolvedIndexes: resolvedIndexList,
      unresolvedRequiredIndexes: unresolvedRequiredIndexList,
      latestClientMessage: userText,
    });
    const dedupeKey = buildDelegationCompletionDedupeKey({
      appointmentId,
      startedAt: String(delegation?.startedAt || ''),
    });
    try {
      completionMessageId = await appendAgentDeskDelegationUpdateMessage({
        pool,
        caregiverId,
        appointmentId,
        content: completionMessage,
        source: 'DELEGATION_COMPLETION',
        dedupeKey,
        metadata: {
          appointmentId,
          caregiverId,
          clientName,
          latestClientMessage: userText,
          resolvedQuestionIndexes: resolvedIndexList,
          unresolvedQuestionIndexes: unresolvedIndexList,
          unresolvedRequiredQuestionIndexes: unresolvedRequiredIndexList,
        },
      });
      if (completionMessageId) {
        completionNotifiedAt = new Date().toISOString();
        progressNotifiedIndexesToPersist = requiredResolvedIndexList;
      }
    } catch (error) {
      console.error('[AI] Failed to write delegation completion update to agent desk', {
        appointmentId,
        caregiverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const previousResolvedIndexes = normalizeDelegationIndexList(delegation?.resolvedQuestionIndexes, questions.length);
  const resolvedChanged =
    previousResolvedIndexes.length !== resolvedIndexList.length ||
    previousResolvedIndexes.some((idx: number, offset: number) => idx !== resolvedIndexList[offset]);
  const progressChanged =
    Array.isArray(progressNotifiedIndexesToPersist) &&
    (
      progressNotifiedIndexesToPersist.length !== previousProgressNotifiedIndexes.length ||
      progressNotifiedIndexesToPersist.some((idx, offset) => idx !== previousProgressNotifiedIndexes[offset])
    );
  const shouldPersistDelegationProgress =
    delegationActive && (
      askedIndexThisTurn !== null ||
      resolvedChanged ||
      progressChanged ||
      Boolean(completionNotifiedAt)
    );
  if (shouldPersistDelegationProgress) {
    const updatedSettings = { ...settings };
    updatedSettings.delegations = { ...(updatedSettings.delegations || {}) };
    const current = updatedSettings.delegations[appointmentId] || delegation || {};
    const currentAsked = Array.isArray(current.askedQuestionIndexes) ? current.askedQuestionIndexes : [];
    const nextAsked = askedIndexThisTurn !== null && !currentAsked.includes(askedIndexThisTurn)
      ? [...currentAsked, askedIndexThisTurn].sort((a: number, b: number) => a - b)
      : currentAsked;
    updatedSettings.delegations[appointmentId] = {
      ...current,
      askedQuestionIndexes: nextAsked,
      resolvedQuestionIndexes: resolvedIndexList,
      progressNotifiedIndexes: progressNotifiedIndexesToPersist || current.progressNotifiedIndexes,
      factCheckClarificationAsked: Boolean(current.factCheckClarificationAsked) || askedClarificationThisTurn,
      completionNotifiedAt: completionNotifiedAt || current.completionNotifiedAt,
    };
    await pool.query(
      `UPDATE user_agents SET persona_settings = $2::jsonb WHERE user_id = $1`,
      [caregiverId, JSON.stringify(updatedSettings)]
    );
  }

  if (progressMessageId) {
    console.log('[AI] Delegation progress update written to agent desk', {
      appointmentId,
      caregiverId,
      progressMessageId,
    });
  }

  if (completionMessageId) {
    console.log('[AI] Delegation completion update written to agent desk', {
      appointmentId,
      caregiverId,
      completionMessageId,
    });
  }

  if (nextChecklist && forcedQuestion === nextChecklist.question) {
    planner = markChecklistQuestionAsked(planner, nextChecklist.checkType);
    await saveChecklistPlanner(pool, appointmentId, planner);
  }

  if (precheckActive && checklistComplete(planner)) {
    const failedChecks = CHECKLIST_ORDER.filter((checkType) => planner.items[checkType].status === 'FAIL');
    const resolved = failedChecks.length === 0;
    const nowIso = new Date().toISOString();
    const latestAgentRes = await pool.query(
      `
        SELECT persona_settings
        FROM user_agents
        WHERE user_id = $1
        LIMIT 1
      `,
      [caregiverId],
    );
    const latestSettings = (latestAgentRes.rows[0]?.persona_settings || settings || {}) as any;
    const latestDelegations = { ...(latestSettings.delegations || {}) };
    const delegationEntry = (latestDelegations[appointmentId] || {}) as any;
    const canWritePrecheckSummaryToDelegation = shouldWritePrecheckSummaryToDelegation(
      Object.keys(delegationEntry).length > 0 ? delegationEntry : null,
    );
    const delegationObjective = String(
      delegationEntry.objective || 'Complete pre-readiness checklist and escalate unresolved blockers.',
    );
    const delegationQuestions = Array.isArray(delegationEntry.questions)
      ? delegationEntry.questions.map(String)
      : CHECKLIST_ORDER.map((k) => planner.items[k].question);
    const precheckSummary = buildPrecheckCompletionSummary(planner);

    if (canWritePrecheckSummaryToDelegation) {
      const updatedSettings = { ...latestSettings };
      updatedSettings.delegations = { ...latestDelegations };
      updatedSettings.delegations[appointmentId] = {
        ...delegationEntry,
        appointmentId,
        active: false,
        objective: delegationObjective,
        questions: delegationQuestions,
        startedAt: delegationEntry.startedAt || nowIso,
        endsAt: delegationEntry.endsAt || nowIso,
        endedAt: nowIso,
        summary: precheckSummary,
        summaryGeneratedAt: nowIso,
        escalationRequired: !resolved,
        source: delegationEntry.source || 'PRECHECK_AUTOMATION',
        systemManaged: true,
      };
      updatedSettings.summaryHistory = [
        ...(Array.isArray(updatedSettings.summaryHistory) ? updatedSettings.summaryHistory : []),
        {
          appointmentId,
          objective: delegationObjective,
          questions: delegationQuestions,
          startedAt: delegationEntry.startedAt || nowIso,
          endedAt: nowIso,
          summary: precheckSummary,
          summaryGeneratedAt: nowIso,
        },
      ];
      await pool.query(
        `UPDATE user_agents SET persona_settings = $2::jsonb WHERE user_id = $1`,
        [caregiverId, JSON.stringify(updatedSettings)],
      );
    } else {
      console.log('[AI] Skipping precheck delegation-summary write for caregiver-managed delegation', {
        appointmentId,
        caregiverId,
      });
    }

    if (!resolved) {
      await pool.query(
        `
          INSERT INTO readiness_events (appointment_id, event_type, details)
          VALUES ($1::uuid, 'PRECHECK_ESCALATED', $2::jsonb)
        `,
        [
          appointmentId,
          JSON.stringify({
            escalatedAt: nowIso,
            reason: 'UNRESOLVED_CHECKS',
            failedChecks,
          }),
        ],
      );
      await pool.query(
        `
          INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
          VALUES ($1::uuid, 'SYSTEM', $2, $3, true)
        `,
        [
          appointmentId,
          caregiverId,
          `Pre-readiness escalation: unresolved items require caregiver follow-up (${failedChecks.join(', ')}). Summary is available in Agent Desk.`,
        ],
      );
    }

    await pool.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        SELECT $1::uuid, 'PRECHECK_COMPLETED', $2::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM readiness_events
          WHERE appointment_id = $1::uuid
            AND event_type = 'PRECHECK_COMPLETED'
        )
      `,
      [
        appointmentId,
        JSON.stringify({
          completedAt: nowIso,
          outcome: resolved ? 'RESOLVED' : 'ESCALATED',
          source: 'AI_INTERPRETER',
        }),
      ],
    );
  }

  console.log(`[AI] 🗣️ Sent Reply: "${replyText}"`);
}
