// services/ai-interpreter-service/src/handlers.ts
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, GetQueueUrlCommand, Message } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { QUEUES } from '@ar/types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function normalizeText(text: string): string {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function tokenize(text: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'for', 'and', 'or', 'on', 'in', 'at', 'any', 'there', 'with', 'you', 'your']);
  return normalizeText(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function looksLikeNonClientOwnedQuestion(text: string): boolean {
  const v = normalizeText(text);
  return (
    v.includes('caregiver') ||
    v.includes('provider') ||
    v.includes('our schedule') ||
    v.includes('my schedule') ||
    v.includes('dispatch') ||
    v.includes('route')
  );
}

function questionLikelyAnswered(question: string, familyMessage: string): boolean {
  const qTokens = tokenize(question);
  const answer = normalizeText(familyMessage);
  if (qTokens.length === 0) return familyMessage.trim().length > 0;
  const matches = qTokens.filter((t) => answer.includes(t)).length;
  return matches >= Math.max(1, Math.floor(qTokens.length / 3));
}

type PlannerCheckType = 'ACCESS_CONFIRMED' | 'MEDS_SUPPLIES_READY' | 'CARE_PLAN_CURRENT';
type PlannerStatus = 'PENDING' | 'PASS' | 'FAIL';
type ReadinessCategory = PlannerCheckType | 'CAREGIVER_MATCH_CONFIRMED';

type LocalPrecheckQuestion = {
  checkType: PlannerCheckType;
  prompt: string;
};

type LocalPrecheckProfile = {
  id: 'HOME_CARE' | 'TRADES' | 'CLINICAL';
  matchKeywords: string[];
  questions: LocalPrecheckQuestion[];
};

const LOCAL_PRECHECK_PROFILES: LocalPrecheckProfile[] = [
  {
    id: 'HOME_CARE',
    matchKeywords: ['aba', 'home care', 'caregiving', 'family support', 'therapy'],
    questions: [
      {
        checkType: 'ACCESS_CONFIRMED',
        prompt: 'Has the way to access your home changed since the last visit? If not, how should the caregiver access it today (code/key/door)?',
      },
      {
        checkType: 'MEDS_SUPPLIES_READY',
        prompt: 'Are required medications and supplies ready for the visit?',
      },
      {
        checkType: 'CARE_PLAN_CURRENT',
        prompt: 'Have there been any updates to visit instructions since last time? If none, just say "no updates".',
      },
    ],
  },
  {
    id: 'TRADES',
    matchKeywords: ['plumb', 'hvac', 'electri', 'repair', 'installation', 'trade', 'contractor'],
    questions: [
      {
        checkType: 'ACCESS_CONFIRMED',
        prompt: 'Can the technician access the work area when they arrive (entry code, gate, parking, on-site contact)?',
      },
      {
        checkType: 'MEDS_SUPPLIES_READY',
        prompt: 'Are required materials/equipment available on-site, or should the technician bring everything?',
      },
      {
        checkType: 'CARE_PLAN_CURRENT',
        prompt: 'Has the job scope changed since the last visit? If nothing changed, just say "no updates".',
      },
    ],
  },
  {
    id: 'CLINICAL',
    matchKeywords: ['dental', 'dentist', 'clinic', 'clinical', 'hygiene', 'orthodont'],
    questions: [
      {
        checkType: 'ACCESS_CONFIRMED',
        prompt: 'Is clinic access/arrival logistics confirmed (transport, check-in timing, and location details)?',
      },
      {
        checkType: 'MEDS_SUPPLIES_READY',
        prompt: 'Are required documents/medications/items ready for the appointment (ID, forms, med list, etc.)?',
      },
      {
        checkType: 'CARE_PLAN_CURRENT',
        prompt: 'Are there any new updates the clinic team should know before the visit? If none, just say "no updates".',
      },
    ],
  },
];

function getDefaultLocalProfile(): LocalPrecheckProfile {
  return LOCAL_PRECHECK_PROFILES[0];
}

function resolveLocalPrecheckProfile(serviceType?: string | null): LocalPrecheckProfile {
  const value = String(serviceType || '').toLowerCase();
  for (const profile of LOCAL_PRECHECK_PROFILES) {
    if (profile.matchKeywords.some((keyword) => value.includes(keyword))) {
      return profile;
    }
  }
  return getDefaultLocalProfile();
}

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
  const profile = getDefaultLocalProfile();
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
  const profile = resolveLocalPrecheckProfile(serviceType);
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

// --- CONSUMER LOOP ---
export async function initializeConsumers(sqs: SQSClient, pool: Pool) {
  console.log('[AI] 🧠 Super-Worker Initialized (Analyst + Agent)...', {
    readinessPolicy: READINESS_POLICY,
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
      const { Messages } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: chatQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5
      }));

      if (Messages && Messages.length > 0) {
        for (const msg of Messages) {
          // Pass the pool to the processor
          await processChatMessage(sqs, pool, msg, updatesQueueUrl);
          
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: chatQueueUrl, ReceiptHandle: msg.ReceiptHandle
          }));
        }
      }
    } catch (error) {
      console.error('[AI] Polling Error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// --- MAIN PROCESSOR ---
async function processChatMessage(sqs: SQSClient, pool: Pool, msg: Message, updatesQueueUrl: string) {
  if (!msg.Body) return;

  try {
    const body = JSON.parse(msg.Body);
    const text = body.text || '';
    const appointmentId = body.appointmentId;
    const senderType = body.senderType;
    const messageId = body.messageId ? String(body.messageId) : undefined;

    // IGNORE: Messages sent by the System or the AI itself (Prevent Loops)
    if (senderType === 'SYSTEM' || senderType === 'AI_AGENT') return;

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
      await runCaregiverAgent(pool, text, appointmentId, readinessUpdates);
    }

  } catch (error) {
    console.error('[AI] Logic Error:', error);
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
        content: `You are an intelligent Healthcare Logistics Assistant. Output valid JSON only.
        
Evaluate the message for these categories only:
1. ACCESS_CONFIRMED
2. MEDS_SUPPLIES_READY
3. CARE_PLAN_CURRENT
4. CAREGIVER_MATCH_CONFIRMED

For each category you have sufficient evidence for, return:
- category
- status: PASS or FAIL
- confidence: number from 0 to 1
- reasoning: one sentence

If there is not enough evidence, omit that category.
If unrelated, return {"updates":[]}.
Interpretation rule for CARE_PLAN_CURRENT:
- If the user says there are no changes/no updates and nothing indicates missing or outdated instructions, classify CARE_PLAN_CURRENT as PASS.

Return exactly:
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
) {
  console.log(`[AI] 🤖 Checking if Caregiver Agent should reply...`);

  // 1. Find who the caregiver is and load agent settings
  const apptResult = await pool.query(`SELECT caregiver_id, service_type FROM appointments WHERE id = $1::uuid`, [appointmentId]);
  if (apptResult.rows.length === 0) return;
  const caregiverId = String(apptResult.rows[0].caregiver_id);
  const serviceType = apptResult.rows[0].service_type ? String(apptResult.rows[0].service_type) : null;

  // 2. Traffic cop check for global status and delegation window
  const agentResult = await pool.query(
    `SELECT status, persona_settings FROM user_agents WHERE user_id = $1`,
    [caregiverId]
  );
  const status = agentResult.rows[0]?.status || 'ACTIVE';
  const settings = (agentResult.rows[0]?.persona_settings || {}) as any;

  const delegation = settings?.delegations?.[appointmentId];
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
  const rawQuestions: unknown[] = Array.isArray(delegation?.questions) ? delegation.questions : [];
  const questions = rawQuestions.map(String);
  const rawAsked: unknown[] = Array.isArray(delegation?.askedQuestionIndexes) ? delegation.askedQuestionIndexes : [];
  const askedQuestionIndexes: number[] = rawAsked
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const alreadyAsked = new Set(askedQuestionIndexes);

  // Mark delegated questions as answered from this incoming client message.
  const answeredByClient = new Set<number>();
  questions.forEach((q, idx) => {
    if (questionLikelyAnswered(q, userText)) {
      answeredByClient.add(idx);
    }
  });

  const unaskedIndexes = questions
    .map((q, idx) => ({ q, idx }))
    .filter(({ q, idx }) => !alreadyAsked.has(idx) && !answeredByClient.has(idx) && !looksLikeNonClientOwnedQuestion(q))
    .map(({ idx }) => idx);
  const delegatedNextQuestion = delegationActive && unaskedIndexes.length > 0 ? questions[unaskedIndexes[0]] : null;
  const nextChecklist = getNextChecklistQuestion(planner);
  const forcedQuestion = nextChecklist?.question || delegatedNextQuestion || null;

  // 3. GENERATE REPLY (Using OpenAI)
  console.log(`[AI] ✅ Agent ACTIVE: Generating reply...`);
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { 
        role: "system", 
        content: `You are the AI delegate for a professional caregiver.
        Conversation mode: ${delegationActive ? 'DELEGATION' : 'SYSTEM_PRECHECK'}
        Delegation objective: ${objective}
        Delegation expires at: ${endsAt ? endsAt.toISOString() : 'N/A'}
        Questions caregiver asked you to collect: ${questions.length > 0 ? questions.join(' | ') : 'None provided'}
        Questions already asked in this delegation: ${askedQuestionIndexes.length > 0 ? askedQuestionIndexes.map((i) => questions[i]).join(' | ') : 'None'}
        Checklist progress: ${checklistProgressSummary(planner)}
        Required next question: ${forcedQuestion || 'None'}
        Rules:
        - Be brief and practical and keep the client informed.
        - Only discuss logistics and appointment coordination.
        - Reason about who is likely to know each detail before you ask.
        - Avoid asking for details that are normally controlled by the care team rather than the client.
        - Ask at most one question.
        - If "Required next question" is provided, include it exactly once.
        - Do not repeat questions that were already asked or already answered.
        - Never give medical advice or emergency guidance.` 
      },
      { role: "user", content: userText },
    ],
    temperature: 0.5,
  });

  const replyText = completion.choices[0].message.content || 'Thanks for the update. I have noted it.';

  // 4. INSERT REPLY INTO DB
  await pool.query(`
    INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
    VALUES ($1, 'AI_AGENT', $2, $3, true)
  `, [appointmentId, caregiverId, replyText]);

  // Persist delegation question progress so we do not keep asking repeats.
  if (delegatedNextQuestion && forcedQuestion === delegatedNextQuestion) {
    const updatedSettings = { ...settings };
    updatedSettings.delegations = { ...(updatedSettings.delegations || {}) };
    const current = updatedSettings.delegations[appointmentId] || delegation;
    const currentAsked = Array.isArray(current.askedQuestionIndexes) ? current.askedQuestionIndexes : [];
    if (!currentAsked.includes(unaskedIndexes[0])) {
      current.askedQuestionIndexes = [...currentAsked, unaskedIndexes[0]];
    }
    updatedSettings.delegations[appointmentId] = current;
    await pool.query(
      `UPDATE user_agents SET persona_settings = $2::jsonb WHERE user_id = $1`,
      [caregiverId, JSON.stringify(updatedSettings)]
    );
  }

  if (nextChecklist && forcedQuestion === nextChecklist.question) {
    planner = markChecklistQuestionAsked(planner, nextChecklist.checkType);
    await saveChecklistPlanner(pool, appointmentId, planner);
  }

  if (precheckActive && checklistComplete(planner)) {
    const failedChecks = CHECKLIST_ORDER.filter((checkType) => planner.items[checkType].status === 'FAIL');
    const resolved = failedChecks.length === 0;
    const nowIso = new Date().toISOString();

    const delegationEntry = (settings?.delegations?.[appointmentId] || {}) as any;
    const delegationObjective = String(delegationEntry.objective || 'Complete pre-readiness checklist and escalate unresolved blockers.');
    const delegationQuestions = Array.isArray(delegationEntry.questions) ? delegationEntry.questions.map(String) : CHECKLIST_ORDER.map((k) => planner.items[k].question);
    const precheckSummary = resolved
      ? `Pre-readiness checklist completed. All critical checks were resolved. ${checklistProgressSummary(planner)}.`
      : `Pre-readiness checklist completed with unresolved blockers requiring caregiver follow-up: ${failedChecks.join(', ')}. ${checklistProgressSummary(planner)}.`;

    const updatedSettings = { ...(settings || {}) };
    updatedSettings.delegations = { ...(updatedSettings.delegations || {}) };
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
