// services/appointment-management-service/src/index.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { loadConfig } from './config';
import { initializeDatabase, testConnection } from './db';
import { initializeSQS, publishMessage } from './sqs';
import { QUEUES } from '@ar/types';

// --- 1. SETUP & CONFIG ---
const config = loadConfig();
const PORT = config.port;

type DelegationEntry = {
  appointmentId: string;
  active: boolean;
  objective: string;
  questions: string[];
  askedQuestionIndexes?: number[];
  startedAt: string;
  endsAt: string;
  endedAt?: string;
  summary?: string;
  summaryGeneratedAt?: string;
};

type DelegationSummaryRecord = {
  appointmentId: string;
  objective: string;
  questions: string[];
  startedAt: string;
  endedAt: string;
  summary: string;
  summaryGeneratedAt: string;
};

type AgentPersonaSettings = {
  delegations?: Record<string, DelegationEntry>;
  summaryHistory?: DelegationSummaryRecord[];
  assistant?: AgentAssistantState;
};

type CaregiverAppointmentRow = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  startTime: string;
  endTime: string;
  serviceType: string;
  appointmentStatus: string;
  locationAddress: string;
};

type AgentCommandIntent =
  | 'START_DELEGATION'
  | 'LOOKUP_ACCESS_CODE'
  | 'MAPS_ROUTE'
  | 'SCHEDULE_OVERVIEW'
  | 'CLIENT_INFO_LOOKUP'
  | 'UNKNOWN';

type ClientMessageEvidenceRow = {
  appointmentId: string;
  appointmentStartTime: string;
  createdAt: string;
  senderType: string;
  content: string;
};

type ClientInfoLookupResult = {
  response: string;
  scannedAppointments: number;
  scannedMessages: number;
  evidence: ClientMessageEvidenceRow[];
};

type MapsLegEstimate = {
  origin: string;
  destination: string;
  departureTime: string;
  durationMinutes: number;
  distanceMeters: number;
};

type StartDelegationInput = {
  userId: string;
  appointmentId: string;
  objective: string;
  durationMinutes: number;
  questions: string[];
  forceStart?: boolean;
};

type StartDelegationResult =
  | {
      ok: true;
      delegation: DelegationEntry;
      firstQuestion: string | null;
    }
  | {
      ok: false;
      status: 404;
      error: string;
    }
  | {
      ok: false;
      status: 409;
      error: string;
      failedChecks: string[];
    };

type AgentToolTraceEntry = {
  tool: string;
  ok: boolean;
  source: string;
  latencyMs: number;
  fetchedAt: string;
  errorCode?: string;
  message?: string;
};

type AssistantTurn = {
  role: 'CAREGIVER' | 'ASSISTANT';
  content: string;
  createdAt: string;
};

type AssistantPendingState = {
  kind: 'MAPS_HOME_ADDRESS' | 'CLIENT_INFO_CONTEXT' | 'DELEGATION_CONTEXT';
  tool: 'MAPS_ROUTE' | 'CLIENT_INFO' | 'START_DELEGATION';
  baseCommand: string;
  requestedAppointmentId?: string;
  createdAt: string;
};

type AssistantMemoryState = {
  clientId?: string;
  clientName?: string;
  appointmentId?: string;
  businessDateHint?: string;
};

type AgentAssistantState = {
  history: AssistantTurn[];
  pending?: AssistantPendingState;
  memory?: AssistantMemoryState;
};

type AssistantPlannerTool = 'SCHEDULE_DAY' | 'MAPS_ROUTE' | 'CLIENT_INFO' | 'START_DELEGATION';

type AssistantPlannerDecision = {
  action: 'RESPOND' | 'ASK_FOLLOW_UP' | 'USE_TOOL';
  response?: string;
  followUpQuestion?: string;
  tool?: AssistantPlannerTool;
  homeAddress?: string;
  appointmentHint?: string;
  objective?: string;
  questions?: string[];
  infoQuestion?: string;
};

type AuthRole = 'CAREGIVER' | 'FAMILY' | 'COORDINATOR';

type SessionUser = {
  userId: string;
  role: AuthRole;
  displayName: string;
  username: string;
};

const APPOINTMENT_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

const READINESS_CHECKS = [
  { key: 'ACCESS_CONFIRMED', critical: true, description: 'Home access is confirmed.' },
  { key: 'MEDS_SUPPLIES_READY', critical: true, description: 'Medications and supplies are ready.' },
  { key: 'CARE_PLAN_CURRENT', critical: true, description: 'Care plan for this visit is current.' },
  { key: 'CAREGIVER_MATCH_CONFIRMED', critical: false, description: 'Caregiver fit/certification is validated.' },
  { key: 'EXPECTATIONS_ALIGNED', critical: false, description: 'Family/caregiver expectations are aligned.' },
  { key: 'VISIT_BRIEF_READY', critical: false, description: 'Visit brief is prepared.' },
];
const CRITICAL_CHECK_KEYS = new Set(READINESS_CHECKS.filter((c) => c.critical).map((c) => c.key));
const BUSINESS_TIME_ZONE = 'America/Los_Angeles';
const SQL_APPOINTMENT_BUSINESS_DATE = `(a.start_time AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;
const SQL_START_TIME_BUSINESS_DATE = `(start_time AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;
const CLIENT_LOOKUP_DEFAULT_APPOINTMENT_LIMIT = 20;
const CLIENT_LOOKUP_DEFAULT_MESSAGE_LIMIT = 400;
const CLIENT_LOOKUP_DEFAULT_SNIPPET_LIMIT = 4;
const CLIENT_LOOKUP_LLM_CANDIDATE_LIMIT = 120;
const LOOKUP_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'for',
  'in',
  'on',
  'at',
  'by',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'has',
  'have',
  'had',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'they',
  'them',
  'their',
  'again',
  'what',
  'when',
  'where',
  'who',
  'which',
  'tell',
  'remind',
  'give',
  'about',
  'patient',
  'client',
  'appointment',
  'appointments',
  'visit',
  'visits',
  'today',
  'please',
  'info',
  'information',
]);

async function main() {
  console.log('[STARTUP] 🚀 Initializing Service...');

  // --- 2. DATABASE ---
  const pool = initializeDatabase(config.database);
  await testConnection(pool);
  const sqsClient = initializeSQS(config.sqs);

  // --- 3. SERVER & CORS (THE FIX) ---
  const app = express();

  // A. The Package
  app.use(cors());

  // B. The Manual Override (Nuclear Option)
  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`); // Log every hit!
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    next();
  });

  app.use(express.json());
  const sessions = new Map<string, SessionUser>();

  function getSessionUser(req: Request): SessionUser | null {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    return sessions.get(token) || null;
  }

  async function getAgentSettings(userId: string): Promise<{ settings: AgentPersonaSettings; role: string }> {
    const result = await pool.query(
      `SELECT role, persona_settings FROM user_agents WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return { settings: {}, role: 'CAREGIVER' };
    }

    return {
      role: result.rows[0].role || 'CAREGIVER',
      settings: (result.rows[0].persona_settings || {}) as AgentPersonaSettings,
    };
  }

  async function saveAgentSettings(
    userId: string,
    role: string,
    settings: AgentPersonaSettings,
    options?: { activateAgent?: boolean }
  ): Promise<void> {
    const activateAgent = Boolean(options?.activateAgent);
    await pool.query(
      `
        INSERT INTO user_agents (user_id, role, status, paused_until, persona_settings)
        VALUES ($1, $2, 'ACTIVE', NULL, $3::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          role = EXCLUDED.role,
          persona_settings = EXCLUDED.persona_settings
          ${activateAgent ? ", status = 'ACTIVE', paused_until = NULL" : ''}
      `,
      [userId, role, JSON.stringify(settings)]
    );
  }

  function getAssistantState(settings: AgentPersonaSettings): AgentAssistantState {
    const raw = (settings.assistant || {}) as Partial<AgentAssistantState>;
    const history = Array.isArray(raw.history)
      ? raw.history
          .map((row) => {
            const role: AssistantTurn['role'] =
              String((row as any)?.role || '').toUpperCase() === 'CAREGIVER' ? 'CAREGIVER' : 'ASSISTANT';
            return {
              role,
              content: String((row as any)?.content || '').trim(),
              createdAt: String((row as any)?.createdAt || new Date().toISOString()),
            };
          })
          .filter((row) => row.content.length > 0)
      : [];
    const pendingRaw = raw.pending as Partial<AssistantPendingState> | undefined;
    const validPendingKinds = new Set(['MAPS_HOME_ADDRESS', 'CLIENT_INFO_CONTEXT', 'DELEGATION_CONTEXT']);
    const validPendingTools = new Set(['MAPS_ROUTE', 'CLIENT_INFO', 'START_DELEGATION']);
    const pending =
      pendingRaw &&
      validPendingKinds.has(String(pendingRaw.kind || '')) &&
      validPendingTools.has(String(pendingRaw.tool || '')) &&
      String(pendingRaw.baseCommand || '').trim()
        ? {
            kind: String(pendingRaw.kind) as AssistantPendingState['kind'],
            tool: String(pendingRaw.tool) as AssistantPendingState['tool'],
            baseCommand: String(pendingRaw.baseCommand || '').trim(),
            requestedAppointmentId: pendingRaw.requestedAppointmentId ? String(pendingRaw.requestedAppointmentId) : undefined,
            createdAt: String(pendingRaw.createdAt || new Date().toISOString()),
          }
        : undefined;

    const memoryRaw = (raw.memory || {}) as Partial<AssistantMemoryState>;
    const memory: AssistantMemoryState = {
      clientId: memoryRaw.clientId ? String(memoryRaw.clientId) : undefined,
      clientName: memoryRaw.clientName ? String(memoryRaw.clientName) : undefined,
      appointmentId: memoryRaw.appointmentId ? String(memoryRaw.appointmentId) : undefined,
      businessDateHint: memoryRaw.businessDateHint ? String(memoryRaw.businessDateHint) : undefined,
    };
    return {
      history: history.slice(-40),
      pending,
      memory: Object.values(memory).some(Boolean) ? memory : undefined,
    };
  }

  function appendAssistantTurn(
    state: AgentAssistantState,
    role: AssistantTurn['role'],
    content: string,
  ): AgentAssistantState {
    const trimmed = String(content || '').trim();
    if (!trimmed) return state;
    const nextHistory = [
      ...(state.history || []),
      { role, content: trimmed, createdAt: new Date().toISOString() },
    ];
    return { ...state, history: nextHistory.slice(-40) };
  }

  function setAssistantPending(
    state: AgentAssistantState,
    pending: Omit<AssistantPendingState, 'createdAt'>,
  ): AgentAssistantState {
    return {
      ...state,
      pending: {
        ...pending,
        createdAt: new Date().toISOString(),
      },
    };
  }

  function clearAssistantPending(state: AgentAssistantState): AgentAssistantState {
    return {
      ...state,
      pending: undefined,
    };
  }

  function updateAssistantMemoryFromAppointment(
    state: AgentAssistantState,
    appointment: CaregiverAppointmentRow | null,
    businessDateHint?: string | null,
  ): AgentAssistantState {
    if (!appointment) return state;
    return {
      ...state,
      memory: {
        ...(state.memory || {}),
        clientId: appointment.clientId,
        clientName: appointment.clientName,
        appointmentId: appointment.appointmentId,
        businessDateHint: businessDateHint || state.memory?.businessDateHint,
      },
    };
  }

  function updateAssistantMemoryFromResolved(
    state: AgentAssistantState,
    resolved: { appointmentId: string; clientId: string; clientName: string; appointmentStartTime?: string } | null,
    businessDateHint?: string | null,
  ): AgentAssistantState {
    if (!resolved) return state;
    return {
      ...state,
      memory: {
        ...(state.memory || {}),
        clientId: resolved.clientId,
        clientName: resolved.clientName,
        appointmentId: resolved.appointmentId,
        businessDateHint: businessDateHint || state.memory?.businessDateHint,
      },
    };
  }

  function combineCommandWithPending(state: AgentAssistantState, command: string): string {
    if (!state.pending) return command;
    if (!shouldMergeWithPending(state, command)) return command;
    return `${state.pending.baseCommand}\nAdditional caregiver details: ${command}`;
  }

  function isCancellationMessage(command: string): boolean {
    const normalized = normalizeCommandText(command);
    return includesAnyTerm(normalized, ['cancel', 'never mind', 'nevermind', 'ignore that', 'stop']);
  }

  function looksLikeAddressInput(command: string): boolean {
    const value = String(command || '');
    return /\d{2,}/.test(value) && /(?:street|st|road|rd|avenue|ave|blvd|boulevard|lane|ln|drive|dr|court|ct|apt|unit|suite|#)/i.test(value);
  }

  function looksLikeGreeting(command: string): boolean {
    const normalized = normalizeCommandText(command);
    if (!normalized) return false;
    return /^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(normalized);
  }

  function looksLikeAcknowledgement(command: string): boolean {
    const normalized = normalizeCommandText(command);
    if (!normalized) return false;
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length > 4) return false;
    return /^(ok|okay|k|got it|sounds good|thanks|thank you|cool|alright|all good|understood|so)$/.test(normalized);
  }

  function mapIntentToPlannerTool(intent: AgentCommandIntent): AssistantPlannerTool | null {
    if (intent === 'SCHEDULE_OVERVIEW') return 'SCHEDULE_DAY';
    if (intent === 'MAPS_ROUTE') return 'MAPS_ROUTE';
    if (intent === 'START_DELEGATION') return 'START_DELEGATION';
    if (intent === 'LOOKUP_ACCESS_CODE' || intent === 'CLIENT_INFO_LOOKUP') return 'CLIENT_INFO';
    return null;
  }

  function tokensCount(command: string): number {
    return normalizeCommandText(command)
      .split(' ')
      .filter(Boolean).length;
  }

  function shouldMergeWithPending(state: AgentAssistantState, command: string): boolean {
    if (!state.pending) return false;
    const pendingCreatedMs = new Date(state.pending.createdAt).getTime();
    if (Number.isFinite(pendingCreatedMs) && Date.now() - pendingCreatedMs > 45 * 60 * 1000) {
      return false;
    }

    const normalized = normalizeCommandText(command);
    if (!normalized) return true;

    const explicitIntent = mapIntentToPlannerTool(detectAgentCommandIntent(command));
    if (explicitIntent && explicitIntent !== state.pending.tool) {
      return false;
    }

    if (state.pending.kind === 'MAPS_HOME_ADDRESS') {
      return looksLikeAddressInput(command) || tokensCount(command) <= 12;
    }

    if (state.pending.kind === 'CLIENT_INFO_CONTEXT' || state.pending.kind === 'DELEGATION_CONTEXT') {
      if (extractClientHint(command)) return true;
      if (Boolean(parseBusinessDateHint(command))) return true;
      return tokensCount(command) <= 14;
    }

    return false;
  }

  function inferToolForFollowUp(
    plannerDecision: AssistantPlannerDecision,
    assistantState: AgentAssistantState,
    commandForPlanning: string,
  ): AssistantPlannerTool | undefined {
    if (plannerDecision.tool) return plannerDecision.tool;
    if (assistantState.pending?.tool) {
      return assistantState.pending.tool as AssistantPlannerTool;
    }
    return mapIntentToPlannerTool(detectAgentCommandIntent(commandForPlanning)) || undefined;
  }

  function shiftIsoDate(dateIso: string, deltaDays: number): string {
    const base = new Date(`${dateIso}T00:00:00-08:00`);
    if (Number.isNaN(base.getTime())) return dateIso;
    base.setUTCDate(base.getUTCDate() + deltaDays);
    const year = base.getUTCFullYear();
    const month = String(base.getUTCMonth() + 1).padStart(2, '0');
    const day = String(base.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseBusinessDateHint(command: string): string | null {
    const normalized = normalizeCommandText(command);
    const today = getCurrentBusinessDateIso();
    if (normalized.includes('yesterday')) return shiftIsoDate(today, -1);
    if (normalized.includes('today')) return today;
    if (normalized.includes('tomorrow')) return shiftIsoDate(today, 1);

    const isoMatch = String(command).match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]);
      const day = Number(isoMatch[3]);
      if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    const mdMatch = String(command).match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
    if (!mdMatch) return null;
    const month = Number(mdMatch[1]);
    const day = Number(mdMatch[2]);
    const nowYear = Number(today.slice(0, 4));
    let year = mdMatch[3] ? Number(mdMatch[3]) : nowYear;
    if (year < 100) year += 2000;
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function compactAssistantHistory(history: AssistantTurn[], limit = 10): string {
    const recent = history.slice(-limit);
    if (recent.length === 0) return '(no prior turns)';
    return recent.map((turn) => `[${turn.role}] ${turn.content.slice(0, 320)}`).join('\n');
  }

  function summarizeAppointmentsForPlanner(appointments: CaregiverAppointmentRow[], limit = 8): string {
    if (appointments.length === 0) return '(no appointments)';
    return appointments
      .slice(0, limit)
      .map(
        (appt, idx) =>
          `${idx + 1}. ${appt.clientName} | ${formatBusinessDateTime(appt.startTime)}-${formatBusinessTime(
            appt.endTime,
          )} | status=${appt.appointmentStatus} | location=${appt.locationAddress || 'unknown'}`,
      )
      .join('\n');
  }

  function normalizeAssistantPlannerDecision(raw: any): AssistantPlannerDecision | null {
    if (!raw || typeof raw !== 'object') return null;
    const action = String(raw.action || '')
      .trim()
      .toUpperCase();
    if (!['RESPOND', 'ASK_FOLLOW_UP', 'USE_TOOL'].includes(action)) {
      return null;
    }

    const tool = String(raw.tool || '')
      .trim()
      .toUpperCase();
    const normalizedTool: AssistantPlannerTool | undefined = (['SCHEDULE_DAY', 'MAPS_ROUTE', 'CLIENT_INFO', 'START_DELEGATION'] as const).includes(
      tool as AssistantPlannerTool,
    )
      ? (tool as AssistantPlannerTool)
      : undefined;

    const questions = Array.isArray(raw.questions)
      ? raw.questions.map((q: unknown) => String(q || '').trim()).filter(Boolean).slice(0, 6)
      : undefined;

    return {
      action: action as AssistantPlannerDecision['action'],
      response: raw.response ? String(raw.response).trim() : undefined,
      followUpQuestion: raw.followUpQuestion ? String(raw.followUpQuestion).trim() : undefined,
      tool: normalizedTool,
      homeAddress: raw.homeAddress ? String(raw.homeAddress).trim() : undefined,
      appointmentHint: raw.appointmentHint ? String(raw.appointmentHint).trim() : undefined,
      objective: raw.objective ? String(raw.objective).trim() : undefined,
      questions,
      infoQuestion: raw.infoQuestion ? String(raw.infoQuestion).trim() : undefined,
    };
  }

  async function planAssistantDecisionWithLLM(input: {
    userId: string;
    command: string;
    assistantState: AgentAssistantState;
    appointments: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
  }): Promise<AssistantPlannerDecision | null> {
    if (!config.openai.apiKey) {
      return null;
    }

    const pendingSummary = input.assistantState.pending
      ? `Pending: kind=${input.assistantState.pending.kind}, baseCommand="${input.assistantState.pending.baseCommand}", requestedAppointmentId=${
          input.assistantState.pending.requestedAppointmentId || 'none'
        }`
      : 'Pending: none';
    const memorySummary = input.assistantState.memory
      ? `Memory: clientName=${input.assistantState.memory.clientName || 'none'}, businessDateHint=${
          input.assistantState.memory.businessDateHint || 'none'
        }, appointmentId=${input.assistantState.memory.appointmentId || 'none'}`
      : 'Memory: none';

    const messages = [
      {
        role: 'system',
        content: `You are a caregiver's personal assistant for appointment logistics.
Return JSON only.

Decide one action:
- RESPOND: answer directly without tools.
- ASK_FOLLOW_UP: ask one clarifying question before using tools.
- USE_TOOL: choose one tool and provide minimal inputs.

Available tools:
1) SCHEDULE_DAY: summarize today's visits and gaps.
2) MAPS_ROUTE: estimate travel legs between visits/home.
3) CLIENT_INFO: search historical messages for client-related details.
4) START_DELEGATION: start client delegation window.

Rules:
- If tool is unnecessary (small talk, generic advice, unsupported request), use RESPOND.
- If map request needs home address and missing, use ASK_FOLLOW_UP and ask for home address.
- If client is ambiguous/missing for CLIENT_INFO or START_DELEGATION, ASK_FOLLOW_UP for client/visit.
- For questions about what was said in chat/messages (food in fridge, access code, "what did they say"), prefer CLIENT_INFO.
- Reuse pending context when present. If pending maps request and current message provides address, call MAPS_ROUTE with homeAddress.
- If the caregiver answers your follow-up with short text ("general", "yes", a date, an address), continue the previous pending task instead of resetting topic.
- If action is ASK_FOLLOW_UP, include the intended tool in "tool".
- Keep tone concise and practical.

Output schema:
{
  "action": "RESPOND|ASK_FOLLOW_UP|USE_TOOL",
  "response": "string (for RESPOND)",
  "followUpQuestion": "string (for ASK_FOLLOW_UP)",
  "tool": "SCHEDULE_DAY|MAPS_ROUTE|CLIENT_INFO|START_DELEGATION (for USE_TOOL)",
  "homeAddress": "string optional",
  "appointmentHint": "string optional",
  "objective": "string optional for START_DELEGATION",
  "questions": ["string"] optional for START_DELEGATION,
  "infoQuestion": "string optional for CLIENT_INFO"
}`,
      },
      {
        role: 'user',
        content: [
          `Caregiver userId: ${input.userId}`,
          `Requested appointmentId: ${input.requestedAppointmentId || 'none'}`,
          pendingSummary,
          memorySummary,
          `Recent assistant history:\n${compactAssistantHistory(input.assistantState.history)}`,
          `Appointment snapshot:\n${summarizeAppointmentsForPlanner(input.appointments)}`,
          `Latest caregiver message: ${input.command}`,
        ].join('\n\n'),
      },
    ];

    const startedAt = Date.now();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openai.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Assistant planner failed (${response.status}): ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as any;
    const rawContent = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!rawContent) {
      throw new Error('Assistant planner returned empty content.');
    }
    const parsed = JSON.parse(rawContent);
    const decision = normalizeAssistantPlannerDecision(parsed);
    if (!decision) {
      throw new Error('Assistant planner returned invalid decision payload.');
    }

    console.log('[AGENT] Planner decision', {
      action: decision.action,
      tool: decision.tool || null,
      latencyMs: Date.now() - startedAt,
    });
    return decision;
  }

  async function generateAssistantDirectResponseWithLLM(input: {
    command: string;
    assistantState: AgentAssistantState;
    appointments: CaregiverAppointmentRow[];
    plannerHint?: string;
  }): Promise<string | null> {
    if (!config.openai.apiKey) {
      return null;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0.4,
          messages: [
            {
              role: 'system',
              content:
                'You are a caregiver personal assistant. Respond naturally, directly, and helpfully like a normal assistant, while staying grounded in caregiver workflow context. For non-tool questions, give a direct answer. For logistics that require data/tooling, ask a concise follow-up or suggest the next concrete action. Do not invent real-time data access you do not have.',
            },
            {
              role: 'user',
              content: [
                `Latest caregiver message: ${input.command}`,
                `Optional planner hint: ${String(input.plannerHint || '').trim() || 'none'}`,
                `Recent assistant history:\n${compactAssistantHistory(input.assistantState.history, 12)}`,
                `Appointment snapshot:\n${summarizeAppointmentsForPlanner(input.appointments, 6)}`,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as any;
      const text = String(payload?.choices?.[0]?.message?.content || '').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  function normalizeKeyPoint(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function formatBusinessDateTime(value: string): string {
    return new Date(value).toLocaleString('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  function extractKeyPoints(messages: Array<{ sender_type: string; content: string }>): string[] {
    const points: string[] = [];
    const seen = new Set<string>();

    const patterns: Array<{ label: string; re: RegExp }> = [
      { label: 'Access update', re: /\b(access|entry|gate|code|key|unlock|locked out)\b/i },
      { label: 'Supplies/materials update', re: /\b(med|medication|supply|supplies|equipment|material|forms|documents)\b/i },
      { label: 'Plan/scope update', re: /\b(plan|instruction|scope|update|changed)\b/i },
      { label: 'Blocker/risk', re: /\b(cannot|cant|can\'t|blocked|delay|missing|issue|problem|not ready|no )\b/i },
      { label: 'ETA/schedule', re: /\b(eta|arrive|arrival|late|time|schedule)\b/i },
    ];

    for (const m of messages) {
      const content = String(m.content || '').trim();
      if (!content) continue;

      for (const p of patterns) {
        if (p.re.test(content)) {
          const line = `${p.label}: [${m.sender_type}] ${content.slice(0, 180)}`;
          const key = normalizeKeyPoint(line);
          if (!seen.has(key)) {
            seen.add(key);
            points.push(line);
          }
          break;
        }
      }
      if (points.length >= 8) break;
    }

    return points;
  }

  function dedupeSummaries(items: DelegationSummaryRecord[]): DelegationSummaryRecord[] {
    const seen = new Set<string>();
    const out: DelegationSummaryRecord[] = [];

    for (const item of items) {
      const key = [
        item.appointmentId,
        item.summaryGeneratedAt,
        normalizeKeyPoint(item.summary || ''),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  async function buildDelegationSummary(appointmentId: string, startedAt: string, endedAt: string): Promise<string> {
    const messagesRes = await pool.query(
      `
        SELECT sender_type, content, created_at
        FROM messages
        WHERE appointment_id = $1
          AND created_at >= $2::timestamptz
          AND created_at <= $3::timestamptz
        ORDER BY created_at ASC
      `,
      [appointmentId, startedAt, endedAt]
    );

    const totalMessages = messagesRes.rows.length;
    const aiMessages = messagesRes.rows.filter((m) => m.sender_type === 'AI_AGENT').length;
    const clientMessages = messagesRes.rows.filter((m) => m.sender_type === 'FAMILY').length;
    const systemMessages = messagesRes.rows.filter((m) => m.sender_type === 'SYSTEM').length;
    const coordinatorMessages = messagesRes.rows.filter((m) => m.sender_type === 'COORDINATOR').length;

    const highlights = messagesRes.rows
      .filter((m) => m.sender_type !== 'SYSTEM')
      .slice(-6)
      .map((m) => `[${m.sender_type}] ${String(m.content).slice(0, 140)}`);

    const keyPoints = extractKeyPoints(messagesRes.rows.map((m) => ({
      sender_type: String(m.sender_type),
      content: String(m.content),
    })));

    const qaPairs: string[] = [];
    for (let i = 0; i < messagesRes.rows.length - 1; i += 1) {
      const a = messagesRes.rows[i];
      const b = messagesRes.rows[i + 1];
      if (String(a.sender_type) === 'AI_AGENT' && (String(b.sender_type) === 'FAMILY' || String(b.sender_type) === 'COORDINATOR')) {
        qaPairs.push(`Q: ${String(a.content).slice(0, 120)}\nA: ${String(b.content).slice(0, 120)}`);
      }
      if (qaPairs.length >= 4) break;
    }

    return [
      `Delegation window: ${formatBusinessDateTime(startedAt)} to ${formatBusinessDateTime(endedAt)}.`,
      `Traffic summary: ${totalMessages} total messages, ${aiMessages} AI responses, ${clientMessages} family messages, ${coordinatorMessages} coordinator messages, ${systemMessages} system events.`,
      keyPoints.length > 0 ? `Key points:\n- ${keyPoints.join('\n- ')}` : 'Key points: none detected from conversation signals.',
      qaPairs.length > 0 ? `Question/answer trace:\n- ${qaPairs.join('\n- ')}` : 'Question/answer trace: no direct Q/A pairs captured.',
      highlights.length > 0 ? `Recent highlights:\n- ${highlights.join('\n- ')}` : 'Recent highlights: none.',
    ].join('\n');
  }

  function looksLikeNonClientOwnedQuestion(text: string): boolean {
    const v = text.toLowerCase();
    return (
      v.includes('caregiver') ||
      v.includes('provider') ||
      v.includes('our schedule') ||
      v.includes('my schedule') ||
      v.includes('dispatch') ||
      v.includes('route')
    );
  }

  async function loadCaregiverAppointments(
    userId: string,
    options?: { businessDate?: string },
  ): Promise<CaregiverAppointmentRow[]> {
    const params: string[] = [userId];
    const dateClause = options?.businessDate
      ? `AND ${SQL_APPOINTMENT_BUSINESS_DATE} = $2::date`
      : '';

    if (options?.businessDate) {
      params.push(options.businessDate);
    }

    const result = await pool.query(
      `
        SELECT
          a.id::text AS appointment_id,
          a.client_id::text AS client_id,
          COALESCE(c.name, 'Unknown Client') AS client_name,
          a.start_time::text AS start_time,
          a.end_time::text AS end_time,
          COALESCE(a.service_type, 'Service') AS service_type,
          COALESCE(a.aloha_status, 'SCHEDULED') AS appointment_status,
          COALESCE(NULLIF(a.location_address, ''), NULLIF(c.service_address, ''), '') AS location_address
        FROM appointments a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.caregiver_id::text = $1
          ${dateClause}
        ORDER BY a.start_time ASC
      `,
      params,
    );

    return result.rows.map((row) => ({
      appointmentId: String(row.appointment_id),
      clientId: String(row.client_id || ''),
      clientName: String(row.client_name || 'Unknown Client'),
      startTime: String(row.start_time || ''),
      endTime: String(row.end_time || ''),
      serviceType: String(row.service_type || 'Service'),
      appointmentStatus: String(row.appointment_status || 'SCHEDULED'),
      locationAddress: String(row.location_address || ''),
    }));
  }

  async function startDelegationWindow(input: StartDelegationInput): Promise<StartDelegationResult> {
    const appointmentId = String(input.appointmentId || '').trim();
    const objective = String(input.objective || '').trim();
    const rawDuration = Number(input.durationMinutes);
    const duration = Number.isFinite(rawDuration) ? Math.max(5, Math.min(180, Math.trunc(rawDuration))) : 30;
    const forceStart = Boolean(input.forceStart);
    const questions = Array.isArray(input.questions)
      ? input.questions.map((q) => String(q).trim()).filter(Boolean)
      : [];

    const apptRes = await pool.query(
      `
        SELECT id::text
        FROM appointments
        WHERE id = $1::uuid
          AND caregiver_id::text = $2
        LIMIT 1
      `,
      [appointmentId, input.userId],
    );
    if (apptRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: 'Appointment not found for this caregiver',
      };
    }

    const checkRes = await pool.query(
      `
        SELECT check_type, status
        FROM readiness_checks
        WHERE appointment_id = $1::uuid
      `,
      [appointmentId],
    );
    const failedCritical = checkRes.rows.filter(
      (row) => CRITICAL_CHECK_KEYS.has(String(row.check_type)) && String(row.status) === 'FAIL',
    );
    if (failedCritical.length > 0 && !forceStart) {
      return {
        ok: false,
        status: 409,
        error: 'Critical readiness checks are failed. Resolve or pass forceStart=true to override.',
        failedChecks: failedCritical.map((row) => String(row.check_type)),
      };
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + duration * 60 * 1000);
    const { settings, role } = await getAgentSettings(input.userId);
    const delegations = settings.delegations || {};

    delegations[appointmentId] = {
      appointmentId,
      active: true,
      objective,
      questions,
      askedQuestionIndexes: [],
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
    };

    settings.delegations = delegations;
    await saveAgentSettings(input.userId, role || 'CAREGIVER', settings, { activateAgent: true });

    const firstValidQuestionIndex = delegations[appointmentId].questions.findIndex(
      (q) => !looksLikeNonClientOwnedQuestion(q),
    );
    const firstQuestion =
      firstValidQuestionIndex >= 0 ? delegations[appointmentId].questions[firstValidQuestionIndex] : null;

    const kickoffMessage = firstQuestion
      ? `Hi, I am assisting your caregiver right now. Quick first question: ${firstQuestion}`
      : `Hi, I am assisting your caregiver right now. I will keep you updated and help coordinate logistics.`;

    await pool.query(
      `
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1, 'AI_AGENT', $2, $3, true)
      `,
      [appointmentId, input.userId, kickoffMessage],
    );

    if (firstValidQuestionIndex >= 0) {
      delegations[appointmentId].askedQuestionIndexes = [firstValidQuestionIndex];
      settings.delegations = delegations;
      await saveAgentSettings(input.userId, role || 'CAREGIVER', settings, { activateAgent: true });
    }

    return {
      ok: true,
      delegation: delegations[appointmentId],
      firstQuestion,
    };
  }

  function normalizeCommandText(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function includesAnyTerm(value: string, terms: string[]): boolean {
    return terms.some((term) => value.includes(term));
  }

  function looksLikeQuestionCommand(command: string): boolean {
    if (String(command || '').includes('?')) return true;
    return /^(what|when|where|who|which|did|does|do|is|are|was|were|can|could|has|have|tell me|remind me|give me)\b/i.test(
      String(command || '').trim(),
    );
  }

  function detectAgentCommandIntent(command: string): AgentCommandIntent {
    const normalized = normalizeCommandText(command);

    const delegationDirective = includesAnyTerm(normalized, [
      'start delegation',
      'start delegating',
      'delegate this',
      'start checking',
      'check whether',
      'can you check',
      'please check',
      'follow up',
      'reach out',
      'ask them',
      'confirm with',
      'verify with',
      'find out',
    ]);

    const delegationVerbPair =
      includesAnyTerm(normalized, ['start', 'begin', 'delegate']) &&
      includesAnyTerm(normalized, ['check', 'ask', 'follow', 'reach', 'confirm', 'verify', 'collect']);

    const hasScheduleNoun = includesAnyTerm(normalized, [
      'schedule',
      'appointment',
      'appointments',
      'visit',
      'visits',
    ]);
    const hasScheduleAsk = includesAnyTerm(normalized, [
      'today',
      'day',
      'between',
      'gap',
      'gaps',
      'next',
      'time between',
      'how much time',
      'free time',
      'break',
    ]);
    const scheduleIntent = hasScheduleNoun && hasScheduleAsk;
    const mapsIntent =
      includesAnyTerm(normalized, [
        'route',
        'map',
        'maps',
        'travel',
        'drive',
        'driving',
        'distance',
        'directions',
        'traffic',
        'eta',
        'commute',
        'home',
        'house',
      ]) &&
      includesAnyTerm(normalized, [
        'today',
        'day',
        'between',
        'next',
        'first',
        'last',
        'to',
        'from',
        'plan',
        'how long',
        'time',
        'appointment',
        'appointments',
        'visit',
        'visits',
      ]);

    const accessCodeIntent =
      (includesAnyTerm(normalized, ['access code', 'entry code', 'gate code', 'door code']) ||
        (normalized.includes('code') && includesAnyTerm(normalized, ['access', 'entry', 'gate', 'door']))) &&
      !delegationDirective &&
      !delegationVerbPair;
    const clientInfoIntent =
      looksLikeQuestionCommand(command) &&
      !scheduleIntent &&
      !accessCodeIntent &&
      !delegationDirective &&
      !delegationVerbPair;

    if (mapsIntent) return 'MAPS_ROUTE';
    if (scheduleIntent) return 'SCHEDULE_OVERVIEW';
    if (accessCodeIntent) return 'LOOKUP_ACCESS_CODE';
    if (delegationDirective || delegationVerbPair) return 'START_DELEGATION';
    if (clientInfoIntent) return 'CLIENT_INFO_LOOKUP';
    return 'UNKNOWN';
  }

  function extractClientHint(command: string): string | null {
    const labeled = command.match(/\b(?:patient|client)\s+([a-z0-9][a-z0-9 '\-]{1,70})/i);
    if (!labeled?.[1]) return null;

    const cleaned = labeled[1]
      .replace(/\b(again|today|tomorrow|appointment|appointments|visit|visits|schedule|code|access|please)\b.*$/i, '')
      .trim();
    return cleaned || null;
  }

  function scoreClientNameMatch(clientName: string, hint: string): number {
    const normalizedClient = normalizeCommandText(clientName);
    const normalizedHint = normalizeCommandText(hint);
    if (!normalizedClient || !normalizedHint) return 0;
    if (normalizedClient === normalizedHint) return 100;
    if (normalizedClient.startsWith(normalizedHint) || normalizedHint.startsWith(normalizedClient)) return 90;
    if (normalizedClient.includes(normalizedHint) || normalizedHint.includes(normalizedClient)) return 75;

    const clientTokens = new Set(normalizedClient.split(' ').filter(Boolean));
    const hintTokens = normalizedHint.split(' ').filter(Boolean);
    let overlap = 0;
    for (const token of hintTokens) {
      if (clientTokens.has(token)) overlap += 1;
    }
    return overlap * 20;
  }

  function getBusinessDateFromTimestamp(value: string): string | null {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  function extractClientHintFromKnownAppointments(
    command: string,
    appointments: CaregiverAppointmentRow[],
  ): string | null {
    const normalizedCommand = normalizeCommandText(command);
    if (!normalizedCommand) return null;
    const scored = appointments
      .map((item) => ({
        name: item.clientName,
        score: scoreClientNameMatch(item.clientName, normalizedCommand),
      }))
      .filter((row) => row.score >= 40)
      .sort((a, b) => b.score - a.score);
    return scored.length > 0 ? scored[0].name : null;
  }

  function pickAppointmentForCommand(
    appointments: CaregiverAppointmentRow[],
    command: string,
    requestedAppointmentId?: string,
  ): CaregiverAppointmentRow | null {
    if (appointments.length === 0) {
      return null;
    }

    if (requestedAppointmentId) {
      const direct = appointments.find((item) => item.appointmentId === requestedAppointmentId);
      if (direct) return direct;
    }

    const clientHint = extractClientHint(command);
    const source = clientHint
      ? appointments
          .map((item) => ({ item, score: scoreClientNameMatch(item.clientName, clientHint) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item)
      : appointments;

    if (clientHint && source.length === 0) {
      return null;
    }

    const candidates = source.length > 0 ? source : appointments;
    const nowMs = Date.now();
    const upcoming = candidates
      .map((item) => ({ item, startMs: new Date(item.startTime).getTime() }))
      .filter((entry) => Number.isFinite(entry.startMs) && entry.startMs >= nowMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (upcoming.length > 0) {
      return upcoming[0].item;
    }

    const recent = candidates
      .map((item) => ({ item, startMs: new Date(item.startTime).getTime() }))
      .filter((entry) => Number.isFinite(entry.startMs))
      .sort((a, b) => b.startMs - a.startMs);
    if (recent.length > 0) {
      return recent[0].item;
    }

    return candidates[0];
  }

  function pickAppointmentForConversation(input: {
    appointments: CaregiverAppointmentRow[];
    command: string;
    requestedAppointmentId?: string;
    memory?: AssistantMemoryState;
  }): CaregiverAppointmentRow | null {
    const { appointments, command, requestedAppointmentId, memory } = input;
    if (appointments.length === 0) return null;

    const explicitClientHint = extractClientHint(command) || extractClientHintFromKnownAppointments(command, appointments);
    const memoryClientHint = memory?.clientName || '';
    const combinedHint = explicitClientHint || memoryClientHint || '';
    const dateHint = parseBusinessDateHint(command) || memory?.businessDateHint || null;

    let target = pickAppointmentForCommand(
      appointments,
      combinedHint ? `${command} client ${combinedHint}` : command,
      requestedAppointmentId || memory?.appointmentId,
    );

    if (dateHint) {
      const byDate = appointments.filter((item) => getBusinessDateFromTimestamp(item.startTime) === dateHint);
      if (byDate.length > 0) {
        target = pickAppointmentForCommand(
          byDate,
          combinedHint ? `${command} client ${combinedHint}` : command,
          requestedAppointmentId || memory?.appointmentId,
        );
      }
    }

    return target;
  }

  function getCurrentBusinessDateIso(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function formatBusinessTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleTimeString('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatDurationMinutes(totalMinutes: number): string {
    const mins = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(mins / 60);
    const remainder = mins % 60;
    if (hours > 0 && remainder > 0) return `${hours}h ${remainder}m`;
    if (hours > 0) return `${hours}h`;
    return `${remainder}m`;
  }

  function buildScheduleOverviewResponse(appointments: CaregiverAppointmentRow[]): string {
    const dateLabel = new Date().toLocaleDateString('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    if (appointments.length === 0) {
      return `No caregiver visits are scheduled for ${dateLabel}.`;
    }

    const lines = appointments.map(
      (row, idx) =>
        `${idx + 1}. ${formatBusinessTime(row.startTime)}-${formatBusinessTime(row.endTime)} • ${row.clientName}`,
    );

    const gaps: string[] = [];
    for (let i = 0; i < appointments.length - 1; i += 1) {
      const currentEnd = new Date(appointments[i].endTime).getTime();
      const nextStart = new Date(appointments[i + 1].startTime).getTime();
      if (!Number.isFinite(currentEnd) || !Number.isFinite(nextStart)) continue;
      const gapMinutes = Math.max(0, Math.round((nextStart - currentEnd) / 60000));
      gaps.push(
        `${formatDurationMinutes(gapMinutes)} between ${appointments[i].clientName} and ${appointments[i + 1].clientName}`,
      );
    }

    const nowMs = Date.now();
    const nextAppointment = appointments.find((item) => new Date(item.startTime).getTime() >= nowMs);
    const nextLine = nextAppointment
      ? `Next visit: ${nextAppointment.clientName} at ${formatBusinessTime(nextAppointment.startTime)}.`
      : 'All visits for today are already in the past.';
    const gapLine =
      gaps.length > 0
        ? `Gaps: ${gaps.join(' | ')}.`
        : appointments.length > 1
        ? 'Gaps: No break time between consecutive visits.'
        : 'Gaps: Single-visit day.';

    return [
      `${appointments.length} visit${appointments.length === 1 ? '' : 's'} on ${dateLabel}.`,
      nextLine,
      lines.join('\n'),
      gapLine,
    ].join('\n');
  }

  function cleanAddress(value: string | null | undefined): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function toUnixSeconds(value: string): number {
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Math.floor(Date.now() / 1000);
    }
    return Math.max(Math.floor(Date.now() / 1000), Math.floor(parsed / 1000));
  }

  function shouldPlanReturnHome(command: string): boolean {
    const normalized = normalizeCommandText(command);
    return includesAnyTerm(normalized, [
      'return home',
      'back home',
      'to home',
      'to my home',
      'to my house',
      'end at home',
      'finish at home',
    ]);
  }

  function wantsHomeEstimate(command: string): boolean {
    const normalized = normalizeCommandText(command);
    return includesAnyTerm(normalized, ['home', 'house']);
  }

  function wantsToHome(command: string): boolean {
    const normalized = normalizeCommandText(command);
    return includesAnyTerm(normalized, ['to home', 'to my home', 'to my house', 'back home', 'return home']);
  }

  function buildMapLegLabel(appointment: CaregiverAppointmentRow): string {
    return `${appointment.clientName} (${formatBusinessTime(appointment.startTime)})`;
  }

  async function loadCaregiverHomeAddress(userId: string): Promise<string | null> {
    const res = await pool.query(
      `
        SELECT home_address
        FROM caregivers
        WHERE id::text = $1
        LIMIT 1
      `,
      [userId],
    );

    const address = cleanAddress(res.rows[0]?.home_address);
    return address || null;
  }

  async function estimateDriveLegWithGoogleMaps(input: {
    origin: string;
    destination: string;
    departureTime: string;
  }): Promise<MapsLegEstimate> {
    if (!config.googleMaps.apiKey) {
      throw new Error('Google Maps is not configured. Set GOOGLE_MAPS_API_KEY in .env.');
    }

    const params = new URLSearchParams({
      origins: input.origin,
      destinations: input.destination,
      mode: 'driving',
      units: 'imperial',
      departure_time: String(toUnixSeconds(input.departureTime)),
      key: config.googleMaps.apiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Maps request failed (${response.status})`);
    }

    const payload = (await response.json()) as any;
    if (String(payload?.status || '') !== 'OK') {
      throw new Error(`Google Maps error: ${String(payload?.status || 'UNKNOWN')}`);
    }

    const element = payload?.rows?.[0]?.elements?.[0];
    if (!element || String(element.status || '') !== 'OK') {
      throw new Error(`Google Maps leg error: ${String(element?.status || 'UNKNOWN')}`);
    }

    const durationSeconds = Number(
      element?.duration_in_traffic?.value ?? element?.duration?.value ?? 0,
    );
    const distanceMeters = Number(element?.distance?.value ?? 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Google Maps did not return a travel duration.');
    }

    return {
      origin: input.origin,
      destination: input.destination,
      departureTime: input.departureTime,
      durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
      distanceMeters: Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : 0,
    };
  }

  function formatMilesFromMeters(meters: number): string {
    if (!Number.isFinite(meters) || meters <= 0) {
      return '0 mi';
    }
    const miles = meters / 1609.344;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }

  async function buildMapsDayPlan(input: {
    userId: string;
    command: string;
    requestedAppointmentId?: string;
    homeAddressOverride?: string;
  }): Promise<{
    response: string;
    legs: MapsLegEstimate[];
    needsHomeAddress?: boolean;
    resolvedAppointment: null | {
      appointmentId: string;
      clientId: string;
      clientName: string;
      appointmentStartTime: string;
    };
  }> {
    const businessDate = getCurrentBusinessDateIso();
    const todayAppointments = (await loadCaregiverAppointments(input.userId, { businessDate })).filter(
      (row) => row.appointmentStatus !== 'CANCELLED',
    );

    if (todayAppointments.length === 0) {
      return {
        response: 'No visits are scheduled today, so there is no route to calculate.',
        legs: [],
        resolvedAppointment: null,
      };
    }

    const normalizedCommand = normalizeCommandText(input.command);
    const targetAppointment = pickAppointmentForCommand(
      todayAppointments,
      input.command,
      input.requestedAppointmentId,
    );
    const resolvedAppointment = targetAppointment
      ? {
          appointmentId: targetAppointment.appointmentId,
          clientId: targetAppointment.clientId,
          clientName: targetAppointment.clientName,
          appointmentStartTime: targetAppointment.startTime,
        }
      : null;

    const homeAddress = cleanAddress(input.homeAddressOverride) || (await loadCaregiverHomeAddress(input.userId)) || '';
    const commandWantsHome = wantsHomeEstimate(input.command);
    const commandToHome = wantsToHome(input.command);
    const includeReturnHome = shouldPlanReturnHome(input.command);
    const betweenOnly = includesAnyTerm(normalizedCommand, ['between appointments', 'between visits', 'between']);

    if (commandWantsHome && !homeAddress) {
      return {
        response: 'What is your home address so I can calculate that route?',
        legs: [],
        needsHomeAddress: true,
        resolvedAppointment,
      };
    }

    if (commandWantsHome && targetAppointment) {
      const appointmentAddress = cleanAddress(targetAppointment.locationAddress);
      if (!appointmentAddress) {
        return {
          response: `I do not have a service address for ${targetAppointment.clientName}, so I cannot calculate that route yet.`,
          legs: [],
          resolvedAppointment,
        };
      }

      const leg = await estimateDriveLegWithGoogleMaps({
        origin: commandToHome ? appointmentAddress : homeAddress,
        destination: commandToHome ? homeAddress : appointmentAddress,
        departureTime: commandToHome ? targetAppointment.endTime : new Date().toISOString(),
      });
      const directionLabel = commandToHome ? `${targetAppointment.clientName} -> home` : `home -> ${targetAppointment.clientName}`;
      return {
        response: [
          `Estimated drive ${directionLabel}: ${formatDurationMinutes(leg.durationMinutes)} (${formatMilesFromMeters(leg.distanceMeters)}).`,
          `Departure basis: ${formatBusinessDateTime(leg.departureTime)}.`,
          'Source: Google Maps Distance Matrix.',
        ].join('\n'),
        legs: [leg],
        resolvedAppointment,
      };
    }

    const routeAppointments = todayAppointments.filter((row) => cleanAddress(row.locationAddress));
    if (routeAppointments.length === 0) {
      return {
        response: 'Today’s appointments are missing location addresses, so I cannot calculate map travel times.',
        legs: [],
        resolvedAppointment,
      };
    }

    const legRequests: Array<{ origin: string; destination: string; departureTime: string; label: string }> = [];
    if (!betweenOnly && homeAddress) {
      legRequests.push({
        origin: homeAddress,
        destination: cleanAddress(routeAppointments[0].locationAddress),
        departureTime: new Date().toISOString(),
        label: `home -> ${buildMapLegLabel(routeAppointments[0])}`,
      });
    }

    for (let i = 0; i < routeAppointments.length - 1; i += 1) {
      legRequests.push({
        origin: cleanAddress(routeAppointments[i].locationAddress),
        destination: cleanAddress(routeAppointments[i + 1].locationAddress),
        departureTime: routeAppointments[i].endTime,
        label: `${buildMapLegLabel(routeAppointments[i])} -> ${buildMapLegLabel(routeAppointments[i + 1])}`,
      });
    }

    if (includeReturnHome && homeAddress && routeAppointments.length > 0) {
      const last = routeAppointments[routeAppointments.length - 1];
      legRequests.push({
        origin: cleanAddress(last.locationAddress),
        destination: homeAddress,
        departureTime: last.endTime,
        label: `${buildMapLegLabel(last)} -> home`,
      });
    }

    if (legRequests.length === 0) {
      return {
        response:
          'I need at least two routed stops to estimate travel between visits. Ask for a home leg or ensure two appointments have addresses.',
        legs: [],
        resolvedAppointment,
      };
    }

    const estimates = await Promise.all(
      legRequests.map(async (leg) => ({
        label: leg.label,
        estimate: await estimateDriveLegWithGoogleMaps(leg),
      })),
    );

    const totalMinutes = estimates.reduce((sum, item) => sum + item.estimate.durationMinutes, 0);
    const lines = estimates.map(
      (item, idx) =>
        `${idx + 1}. ${item.label}: ${formatDurationMinutes(item.estimate.durationMinutes)} (${formatMilesFromMeters(item.estimate.distanceMeters)})`,
    );

    return {
      response: [
        `Estimated drive plan for today (${routeAppointments.length} visit${routeAppointments.length === 1 ? '' : 's'}):`,
        lines.join('\n'),
        `Total estimated drive time: ${formatDurationMinutes(totalMinutes)}.`,
        'Source: Google Maps Distance Matrix.',
      ].join('\n'),
      legs: estimates.map((item) => item.estimate),
      resolvedAppointment,
    };
  }

  function deriveDelegationPlan(command: string): { objective: string; questions: string[] } {
    const trimmed = String(command || '').trim();
    const simplified = trimmed
      .replace(/^\s*(can you|could you|please|i want you to|i need you to|agent[:,]?)\s*/i, '')
      .replace(/[?.!]+$/g, '')
      .trim();

    const objective = simplified
      ? simplified.length > 220
        ? `${simplified.slice(0, 217)}...`
        : simplified
      : 'Collect logistics updates and keep the client informed.';

    const whetherMatch = simplified.match(/\bwhether\s+(.+)$/i);
    const actionMatch = simplified.match(/\b(?:check|confirm|verify|ask|find out|follow up(?: on)?|reach out(?: to)?)\s+(.+)$/i);
    let focus = String(whetherMatch?.[1] || actionMatch?.[1] || '').replace(/[?.!]+$/g, '').trim();
    if (!focus) {
      focus = 'there are any logistics updates before the visit';
    }

    const question =
      focus.toLowerCase().startsWith('if ') || focus.toLowerCase().startsWith('whether ')
        ? `Can you confirm ${focus}?`
        : `Can you confirm if ${focus}?`;

    return { objective, questions: [question] };
  }

  function compactSnippet(text: string, limit = 180): string {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (compact.length <= limit) return compact;
    return `${compact.slice(0, limit - 1)}...`;
  }

  function extractAccessCodeToken(content: string): string | null {
    const patterns: RegExp[] = [
      /\b(?:access|entry|gate|door)\s*code\s*(?:is|=|:|-)\s*([a-z0-9#*\-]{3,12})\b/i,
      /\bcode\s*(?:is|=|:|-)\s*([a-z0-9#*\-]{3,12})\b/i,
      /\b(?:gate|entry|door)\s*(?:is|=|:|-)\s*([a-z0-9#*\-]{3,12})\b/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (!match?.[1]) continue;
      const candidate = String(match[1]).replace(/[.,;!?]+$/g, '').trim();
      if (/^[a-z0-9#*\-]{3,12}$/i.test(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  async function lookupAccessCodeEvidence(appointmentId: string): Promise<{
    code: string | null;
    senderType: string | null;
    createdAt: string | null;
    snippet: string | null;
  }> {
    const messagesRes = await pool.query(
      `
        SELECT sender_type, content, created_at::text AS created_at
        FROM messages
        WHERE appointment_id = $1::uuid
          AND content ~* '(access|entry|gate|door|code|key)'
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [appointmentId],
    );

    for (const row of messagesRes.rows) {
      const content = String(row.content || '');
      const token = extractAccessCodeToken(content);
      if (!token) continue;
      return {
        code: token,
        senderType: String(row.sender_type || ''),
        createdAt: String(row.created_at || ''),
        snippet: compactSnippet(content),
      };
    }

    const latestHumanMessage =
      messagesRes.rows.find((row) => String(row.sender_type || '') !== 'AI_AGENT') || messagesRes.rows[0];
    return {
      code: null,
      senderType: latestHumanMessage ? String(latestHumanMessage.sender_type || '') : null,
      createdAt: latestHumanMessage ? String(latestHumanMessage.created_at || '') : null,
      snippet: latestHumanMessage ? compactSnippet(String(latestHumanMessage.content || '')) : null,
    };
  }

  function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(numeric)));
  }

  function recordToolTrace(
    trace: AgentToolTraceEntry[],
    input: {
      tool: string;
      source: string;
      startedAtMs: number;
      ok: boolean;
      errorCode?: string;
      message?: string;
    },
  ): void {
    trace.push({
      tool: input.tool,
      ok: input.ok,
      source: input.source,
      latencyMs: Math.max(0, Date.now() - input.startedAtMs),
      fetchedAt: new Date().toISOString(),
      errorCode: input.errorCode,
      message: input.message,
    });
  }

  function extractLookupKeywords(question: string, clientName?: string): string[] {
    const normalizedQuestion = normalizeCommandText(question);
    const clientTokens = new Set(normalizeCommandText(String(clientName || '')).split(' ').filter(Boolean));
    const tokens = normalizedQuestion
      .split(' ')
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 &&
          !LOOKUP_STOP_WORDS.has(token) &&
          !clientTokens.has(token),
      );
    return Array.from(new Set(tokens)).slice(0, 10);
  }

  function extractPhoneToken(content: string): string | null {
    const match = String(content || '').match(
      /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/,
    );
    return match ? match[0].trim() : null;
  }

  function scoreMessageForKeywords(content: string, keywords: string[]): number {
    const normalized = normalizeCommandText(content);
    if (!normalized) return 0;
    if (keywords.length === 0) return 1;

    let score = 0;
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        score += 2;
      }
    }
    return score;
  }

  function fallbackSelectEvidenceRows(
    evidenceRows: ClientMessageEvidenceRow[],
    question: string,
    clientName: string,
    snippetLimit: number,
  ): ClientMessageEvidenceRow[] {
    const keywords = extractLookupKeywords(question, clientName);
    const ranked = evidenceRows
      .map((row) => ({
        row,
        score: scoreMessageForKeywords(row.content, keywords),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(b.row.createdAt).localeCompare(String(a.row.createdAt)),
      );
    const matched = keywords.length > 0 ? ranked.filter((item) => item.score > 0) : ranked;
    const selected = (matched.length > 0 ? matched : ranked).slice(0, snippetLimit).map((item) => item.row);
    if (selected.length > 0) return selected;

    return evidenceRows
      .filter((row) => row.senderType === 'FAMILY' || row.senderType === 'COORDINATOR')
      .slice(0, snippetLimit);
  }

  async function selectRelevantEvidenceWithLLM(input: {
    question: string;
    clientName: string;
    evidenceRows: ClientMessageEvidenceRow[];
    snippetLimit: number;
  }): Promise<ClientMessageEvidenceRow[] | null> {
    if (!config.openai.apiKey || input.evidenceRows.length === 0) {
      return null;
    }

    const candidates = input.evidenceRows.slice(0, CLIENT_LOOKUP_LLM_CANDIDATE_LIMIT);
    const candidateText = candidates
      .map(
        (row, idx) =>
          `${idx + 1}|${formatBusinessDateTime(row.createdAt)}|${row.senderType}|${compactSnippet(row.content, 220)}`,
      )
      .join('\n');

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Select the message rows most relevant to answering the caregiver question. Return JSON: {"indexes":[number]}. Use 1-based indexes from the provided list. Choose up to 8 rows.',
            },
            {
              role: 'user',
              content: [
                `Client: ${input.clientName}`,
                `Question: ${input.question}`,
                'Rows:',
                candidateText,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { indexes?: unknown };
      const indexes = Array.isArray(parsed?.indexes)
        ? parsed.indexes
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= candidates.length)
        : [];
      if (indexes.length === 0) return null;
      const unique = Array.from(new Set(indexes));
      const selected = unique
        .slice(0, Math.max(input.snippetLimit * 2, input.snippetLimit))
        .map((value) => candidates[value - 1])
        .filter(Boolean);
      return selected.length > 0 ? selected.slice(0, input.snippetLimit) : null;
    } catch {
      return null;
    }
  }

  async function lookupClientInfoAcrossMessages(input: {
    userId: string;
    clientId: string;
    clientName: string;
    question: string;
    appointmentLimit?: number;
    messageLimit?: number;
    snippetLimit?: number;
    targetBusinessDate?: string;
    specificAppointmentId?: string;
  }): Promise<ClientInfoLookupResult> {
    const messageLimit = clampInteger(
      input.messageLimit,
      20,
      600,
      CLIENT_LOOKUP_DEFAULT_MESSAGE_LIMIT,
    );
    const snippetLimit = clampInteger(
      input.snippetLimit,
      1,
      8,
      CLIENT_LOOKUP_DEFAULT_SNIPPET_LIMIT,
    );

    const hasSpecificAppointmentId = Boolean(String(input.specificAppointmentId || '').trim());
    const hasDateFilter = /^\d{4}-\d{2}-\d{2}$/.test(String(input.targetBusinessDate || '').trim());
    const params: string[] = [input.userId, input.clientId];
    let whereSql = `
        WHERE a.caregiver_id::text = $1
          AND a.client_id::text = $2
    `;
    if (hasSpecificAppointmentId) {
      params.push(String(input.specificAppointmentId || '').trim());
      whereSql += ` AND a.id::text = $${params.length}`;
    } else if (hasDateFilter) {
      params.push(String(input.targetBusinessDate || '').trim());
      whereSql += ` AND ${(SQL_START_TIME_BUSINESS_DATE).replace('start_time', 'a.start_time')} = $${params.length}::date`;
    }

    const appointmentRes = await pool.query(
      `
        SELECT
          COUNT(*)::int AS appointment_count
        FROM appointments a
        ${whereSql}
      `,
      params,
    );

    const appointmentCount = Number(appointmentRes.rows[0]?.appointment_count || 0);
    if (appointmentCount === 0) {
      return {
        response: `No appointments were found for ${input.clientName}.`,
        scannedAppointments: 0,
        scannedMessages: 0,
        evidence: [],
      };
    }

    const messageParams = [...params, String(messageLimit)];
    const messagesRes = await pool.query(
      `
        SELECT
          m.appointment_id::text AS appointment_id,
          a.start_time::text AS appointment_start_time,
          m.sender_type,
          m.content,
          m.created_at::text AS created_at
        FROM messages m
        JOIN appointments a ON a.id = m.appointment_id
        ${whereSql}
        ORDER BY m.created_at DESC
        LIMIT $${messageParams.length}::int
      `,
      messageParams,
    );

    const evidenceRows: ClientMessageEvidenceRow[] = messagesRes.rows.map((row) => ({
      appointmentId: String(row.appointment_id || ''),
      appointmentStartTime: String(row.appointment_start_time || ''),
      createdAt: String(row.created_at || ''),
      senderType: String(row.sender_type || ''),
      content: String(row.content || ''),
    }));

    if (evidenceRows.length === 0) {
      const scope =
        hasSpecificAppointmentId
          ? 'that appointment'
          : hasDateFilter
          ? `appointments on ${input.targetBusinessDate}`
          : 'this client history';
      return {
        response: `I checked ${scope} for ${input.clientName}, but there are no messages yet.`,
        scannedAppointments: appointmentCount,
        scannedMessages: 0,
        evidence: [],
      };
    }

    const normalizedQuestion = normalizeCommandText(input.question);

    if (includesAnyTerm(normalizedQuestion, ['access code', 'entry code', 'gate code', 'door code', 'access', 'entry', 'code'])) {
      for (const row of evidenceRows) {
        const code = extractAccessCodeToken(row.content);
        if (!code) continue;
        return {
          response: `Latest access code I found for ${input.clientName} is "${code}" from ${formatBusinessDateTime(row.createdAt)} [${row.senderType.toLowerCase()}].`,
          scannedAppointments: appointmentCount,
          scannedMessages: evidenceRows.length,
          evidence: [row],
        };
      }
    }

    if (includesAnyTerm(normalizedQuestion, ['phone', 'call', 'number'])) {
      for (const row of evidenceRows) {
        const phone = extractPhoneToken(row.content);
        if (!phone) continue;
        return {
          response: `Latest phone number mention for ${input.clientName} is "${phone}" from ${formatBusinessDateTime(row.createdAt)} [${row.senderType.toLowerCase()}].`,
          scannedAppointments: appointmentCount,
          scannedMessages: evidenceRows.length,
          evidence: [row],
        };
      }
    }

    const llmSelected = await selectRelevantEvidenceWithLLM({
      question: input.question,
      clientName: input.clientName,
      evidenceRows,
      snippetLimit,
    });
    const selected = llmSelected || fallbackSelectEvidenceRows(evidenceRows, input.question, input.clientName, snippetLimit);

    if (selected.length === 0) {
      return {
        response: `I searched ${evidenceRows.length} messages for ${input.clientName}, but I could not find enough detail to answer "${input.question.trim()}".`,
        scannedAppointments: appointmentCount,
        scannedMessages: evidenceRows.length,
        evidence: [],
      };
    }

    const snippets = selected.map(
      (row, index) =>
        `${index + 1}. ${formatBusinessDateTime(row.createdAt)} [${row.senderType}] ${compactSnippet(row.content)}`,
    );
    return {
      response: [
        `I searched ${evidenceRows.length} recent messages for ${input.clientName}.`,
        `Most relevant notes:`,
        snippets.join('\n'),
      ].join('\n'),
      scannedAppointments: appointmentCount,
      scannedMessages: evidenceRows.length,
      evidence: selected,
    };
  }

  async function synthesizeClientInfoAnswer(input: {
    question: string;
    clientName: string;
    evidence: ClientMessageEvidenceRow[];
    fallback: string;
  }): Promise<string> {
    if (!config.openai.apiKey || input.evidence.length === 0) {
      return input.fallback;
    }

    try {
      const evidenceText = input.evidence
        .slice(0, 6)
        .map(
          (row, idx) =>
            `${idx + 1}) ${formatBusinessDateTime(row.createdAt)} [${row.senderType}] ${compactSnippet(row.content, 240)}`,
        )
        .join('\n');

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content:
                'You are a caregiver logistics assistant. Answer strictly from provided evidence. If the evidence contains direct details (for example item names, codes, timing, family statements), state them explicitly. If evidence is insufficient, say so briefly. Keep answer concise (2-4 sentences).',
            },
            {
              role: 'user',
              content: [
                `Client: ${input.clientName}`,
                `Question: ${input.question}`,
                `Evidence:`,
                evidenceText,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) {
        return input.fallback;
      }
      const payload = (await response.json()) as any;
      const text = String(payload?.choices?.[0]?.message?.content || '').trim();
      return text || input.fallback;
    } catch {
      return input.fallback;
    }
  }

  // --- 4. ROUTES ---

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', port: PORT });
  });

  app.get('/readiness/check-definitions', (req: Request, res: Response) => {
    res.json({ data: READINESS_CHECKS });
  });

  app.get('/auth/accounts', async (req: Request, res: Response) => {
    try {
      const role = String(req.query.role || '').toUpperCase();
      const allowedRoles = new Set(['CAREGIVER', 'FAMILY']);
      const params: any[] = [];
      const roleFilter = allowedRoles.has(role) ? `WHERE role = $1` : '';

      if (roleFilter) {
        params.push(role);
      }

      const result = await pool.query(
        `
          SELECT username, role, person_id, display_name
          FROM auth_users
          ${roleFilter}
          ORDER BY role, display_name
        `,
        params
      );

      res.json({
        data: result.rows.map((row) => ({
          username: row.username,
          role: row.role,
          userId: row.person_id,
          name: row.display_name,
        })),
        testPassword: 'demo123',
      });
    } catch (error) {
      console.error('Failed to load auth accounts', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/auth/login', async (req: Request, res: Response) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');

      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }

      const result = await pool.query(
        `
          SELECT username, role, person_id, display_name, password_plaintext
          FROM auth_users
          WHERE username = $1
          LIMIT 1
        `,
        [username]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const account = result.rows[0];
      if (String(account.password_plaintext) !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = crypto.randomBytes(24).toString('hex');
      const sessionUser: SessionUser = {
        userId: account.person_id,
        role: account.role,
        displayName: account.display_name,
        username: account.username,
      };
      sessions.set(token, sessionUser);

      res.json({
        token,
        user: {
          userId: sessionUser.userId,
          role: sessionUser.role,
          name: sessionUser.displayName,
          username: sessionUser.username,
        },
      });
    } catch (error) {
      console.error('Failed to login user', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments
  app.get('/appointments', async (req: Request, res: Response) => {
    try {
      const sessionUser = getSessionUser(req);
      // 1. Extract identity (prefer authenticated session when present)
      const { userId, role, caregiverId, date } = req.query;
      
      // Fallback just in case the frontend still sends caregiverId
      const targetId = sessionUser?.userId || userId || caregiverId; 
      const effectiveRole = String(sessionUser?.role || role || '').toUpperCase();
      const requestedDate = String(date || '').trim();
      const hasDateFilter = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);

      if (!targetId && effectiveRole !== 'COORDINATOR') {
        return res.status(400).json({ error: 'Missing userId' });
      }

      console.log(`[API] Fetching appointments for: ${targetId} (Role: ${effectiveRole})`, {
        dateFilter: hasDateFilter ? requestedDate : 'none',
      });

      // 2. DYNAMIC FILTERING LOGIC
      const whereClauses: string[] = [];
      let queryParams: any[] = [];

      if (effectiveRole === 'FAMILY' || effectiveRole === 'PATIENT') {
        whereClauses.push('a.client_id = $1');
        queryParams = [targetId];
      } else if (effectiveRole === 'COORDINATOR') {
        // Coordinators see all appointments by default.
        queryParams = [];
      } else {
        // Default to Caregiver
        whereClauses.push('a.caregiver_id = $1');
        queryParams = [targetId];
      }

      if (hasDateFilter) {
        queryParams.push(requestedDate);
        whereClauses.push(`${SQL_APPOINTMENT_BUSINESS_DATE} = $${queryParams.length}::date`);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // 3. EXECUTE THE QUERY
      const result = await pool.query(`
        SELECT 
          a.id, 
          a.aloha_appointment_id,
          a.start_time,
          a.end_time,
          a.service_type,
          a.aloha_status,
          a.readiness_status,
          c.name as client_name,
          c.service_address,
          c.primary_phone
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
        ${whereSql}
        ORDER BY a.start_time DESC
      `, queryParams);
      
      console.log(`[API] Found ${result.rows.length} records.`);
      res.json(result.rows);

    } catch (error) {
      console.error('[API ERROR]', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/readiness
  app.get('/appointments/:id/readiness', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      // 1. Get the High-Level Status directly from the 'appointments' table
      const summaryRes = await pool.query(`
        SELECT readiness_status 
        FROM appointments 
        WHERE id = $1
      `, [id]);

      if (summaryRes.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      // 2. Get the specific checklist items
      const checksRes = await pool.query(`
        SELECT check_type, status, updated_at 
        FROM readiness_checks 
        WHERE appointment_id = $1
      `, [id]);

      const summary = summaryRes.rows[0];
      const statusByType = new Map(checksRes.rows.map((r) => [String(r.check_type), r]));
      const checks = READINESS_CHECKS.map((def) => {
        const row = statusByType.get(def.key);
        return {
          check_type: def.key,
          status: row?.status || 'PENDING',
          updated_at: row?.updated_at || null,
          critical: def.critical,
          description: def.description,
        };
      });

      res.json({
        appointmentId: id,
        status: summary.readiness_status || 'NOT_STARTED',
        riskScore: 0, // Hardcoded to 0 for now to keep the UI happy
        checks
      });
    } catch (error) {
      console.error('Failed to fetch readiness:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // DELETE /testing/appointments/by-date/:date
  // Dev/test utility: deletes all appointments scheduled on a specific YYYY-MM-DD date.
  app.delete('/testing/appointments/by-date/:date', async (req: Request, res: Response) => {
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const apptRes = await client.query(
        `
          SELECT id::text
          FROM appointments
          WHERE ${SQL_START_TIME_BUSINESS_DATE} = $1::date
        `,
        [date]
      );
      const appointmentIds = apptRes.rows.map((r) => String(r.id));

      if (appointmentIds.length === 0) {
        await client.query('ROLLBACK');
        return res.json({
          success: true,
          data: {
            date,
            deletedAppointments: 0,
            deletedMessages: 0,
            deletedReadinessEvents: 0,
            deletedReadinessChecks: 0,
            deletedTimesheets: 0,
            cleanedUserAgents: 0,
          },
        });
      }

      const apptArray = appointmentIds;
      const messagesRes = await client.query(
        `DELETE FROM messages WHERE appointment_id = ANY($1::uuid[]) RETURNING id`,
        [apptArray]
      );
      const eventsRes = await client.query(
        `DELETE FROM readiness_events WHERE appointment_id = ANY($1::uuid[]) RETURNING id`,
        [apptArray]
      );
      const checksRes = await client.query(
        `DELETE FROM readiness_checks WHERE appointment_id = ANY($1::uuid[]) RETURNING id`,
        [apptArray]
      );
      const timesheetsRes = await client.query(
        `DELETE FROM timesheets WHERE appointment_id = ANY($1::uuid[]) RETURNING id`,
        [apptArray]
      );

      const apptDeleteRes = await client.query(
        `DELETE FROM appointments WHERE id = ANY($1::uuid[]) RETURNING id`,
        [apptArray]
      );

      // Remove deleted appointment references from delegation state/history.
      const agentsRes = await client.query(
        `
          SELECT user_id, persona_settings
          FROM user_agents
        `
      );

      let cleanedUserAgents = 0;
      const idSet = new Set(appointmentIds);
      for (const row of agentsRes.rows) {
        const userId = String(row.user_id);
        const settings = (row.persona_settings || {}) as any;
        let changed = false;

        const delegations = { ...(settings.delegations || {}) };
        for (const appointmentId of Object.keys(delegations)) {
          if (idSet.has(appointmentId)) {
            delete delegations[appointmentId];
            changed = true;
          }
        }

        const summaryHistory = Array.isArray(settings.summaryHistory)
          ? settings.summaryHistory.filter((entry: any) => !idSet.has(String(entry?.appointmentId || '')))
          : [];
        if (Array.isArray(settings.summaryHistory) && summaryHistory.length !== settings.summaryHistory.length) {
          changed = true;
        }

        if (changed) {
          settings.delegations = delegations;
          settings.summaryHistory = summaryHistory;
          await client.query(
            `
              UPDATE user_agents
              SET persona_settings = $2::jsonb
              WHERE user_id = $1
            `,
            [userId, JSON.stringify(settings)]
          );
          cleanedUserAgents += 1;
        }
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          date,
          deletedAppointments: apptDeleteRes.rowCount || 0,
          deletedMessages: messagesRes.rowCount || 0,
          deletedReadinessEvents: eventsRes.rowCount || 0,
          deletedReadinessChecks: checksRes.rowCount || 0,
          deletedTimesheets: timesheetsRes.rowCount || 0,
          cleanedUserAgents,
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to delete appointments by date', error);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      client.release();
    }
  });

  // GET /appointments/:id/debug/readiness-flow
  // End-to-end observability view for ingestion -> precheck -> AI updates -> readiness state.
  app.get('/appointments/:id/debug/readiness-flow', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const apptRes = await pool.query(
        `
          SELECT
            a.id::text AS appointment_id,
            a.aloha_appointment_id,
            a.start_time,
            a.end_time,
            a.service_type,
            COALESCE(a.aloha_status, 'SCHEDULED') AS appointment_status,
            a.readiness_status,
            a.client_id::text,
            a.caregiver_id::text,
            c.name AS client_name
          FROM appointments a
          LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.id = $1::uuid
          LIMIT 1
        `,
        [id]
      );
      if (apptRes.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      const checksRes = await pool.query(
        `
          SELECT check_type, status, source, updated_at
          FROM readiness_checks
          WHERE appointment_id = $1::uuid
          ORDER BY check_type ASC
        `,
        [id]
      );

      const eventsRes = await pool.query(
        `
          SELECT event_type, details, created_at
          FROM readiness_events
          WHERE appointment_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [id]
      );

      const messagesRes = await pool.query(
        `
          SELECT sender_type, is_agent, content, created_at
          FROM messages
          WHERE appointment_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 30
        `,
        [id]
      );

      const caregiverId = String(apptRes.rows[0].caregiver_id || '');
      let delegation = null;
      if (caregiverId) {
        const agentRes = await pool.query(
          `
            SELECT persona_settings
            FROM user_agents
            WHERE user_id = $1
            LIMIT 1
          `,
          [caregiverId]
        );
        const settings = (agentRes.rows[0]?.persona_settings || {}) as any;
        delegation = settings?.delegations?.[id] || null;
      }

      res.json({
        success: true,
        data: {
          appointment: apptRes.rows[0],
          readinessChecks: checksRes.rows,
          recentReadinessEvents: eventsRes.rows,
          recentMessages: messagesRes.rows,
          caregiverDelegation: delegation,
        },
      });
    } catch (error) {
      console.error('Failed readiness flow debug lookup', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // PUT /appointments/:id/status
  // Appointment lifecycle transitions used to drive precheck handoff gating.
  app.put('/appointments/:id/status', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const nextStatus = String(req.body.status || '').trim().toUpperCase();
      if (!APPOINTMENT_STATUSES.includes(nextStatus as (typeof APPOINTMENT_STATUSES)[number])) {
        return res.status(400).json({ error: `Invalid status: ${nextStatus}` });
      }

      const updateRes = await pool.query(
        `
          UPDATE appointments
          SET aloha_status = $2, updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING id, aloha_status
        `,
        [id, nextStatus]
      );

      if (updateRes.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      await pool.query(
        `
          INSERT INTO readiness_events (appointment_id, event_type, details)
          VALUES ($1::uuid, 'APPOINTMENT_STATUS_CHANGED', $2::jsonb)
        `,
        [
          id,
          JSON.stringify({
            status: nextStatus,
            changedAt: new Date().toISOString(),
          }),
        ]
      );

      await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, {
        messageId: `lifecycle-${Date.now()}`,
        appointmentId: id,
        trigger: 'LIFECYCLE',
        timestamp: new Date().toISOString(),
        payload: { id },
      });

      res.json({
        success: true,
        data: {
          appointmentId: updateRes.rows[0].id,
          status: updateRes.rows[0].aloha_status,
        },
      });
    } catch (error) {
      console.error('Failed to update appointment status', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /appointments/:id/readiness/checks
  // Manually updates a readiness check and triggers readiness re-evaluation.
  app.post('/appointments/:id/readiness/checks', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const checkType = String(req.body.checkType || '').trim().toUpperCase();
      const status = String(req.body.status || '').trim().toUpperCase();
      const source = String(req.body.source || 'MANUAL').trim();

      if (!checkType || !status) {
        return res.status(400).json({ error: 'checkType and status are required' });
      }
      if (!READINESS_CHECKS.some((c) => c.key === checkType)) {
        return res.status(400).json({ error: `Unknown checkType: ${checkType}` });
      }
      if (!['PENDING', 'PASS', 'FAIL'].includes(status)) {
        return res.status(400).json({ error: `Invalid status: ${status}` });
      }

      await pool.query(
        `
          INSERT INTO readiness_checks (appointment_id, check_type, status, source, updated_at)
          VALUES ($1::uuid, $2, $3, $4, NOW())
          ON CONFLICT (appointment_id, check_type)
          DO UPDATE SET
            status = EXCLUDED.status,
            source = EXCLUDED.source,
            updated_at = NOW()
        `,
        [id, checkType, status, source]
      );

      await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, {
        messageId: `manual-${Date.now()}`,
        appointmentId: id,
        trigger: 'MANUAL',
        timestamp: new Date().toISOString(),
      });

      res.json({ success: true, data: { appointmentId: id, checkType, status, source } });
    } catch (error) {
      console.error('Failed to update readiness check', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /appointments/:id/precheck/reset
  // Clears precheck conversation markers so readiness-engine can re-kickoff precheck for this appointment.
  app.post('/appointments/:id/precheck/reset', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const apptRes = await pool.query(
        `
          SELECT id
          FROM appointments
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [id]
      );
      if (apptRes.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      const resetResult = await pool.query(
        `
          WITH deleted_events AS (
            DELETE FROM readiness_events
            WHERE appointment_id = $1::uuid
              AND event_type IN ('PRECHECK_STARTED', 'PRECHECK_COMPLETED', 'PRECHECK_PLANNER')
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM messages
            WHERE appointment_id = $1::uuid
              AND sender_type = 'AI_AGENT'
              AND (
                content ILIKE 'Hi %care team assistant%'
                OR content ILIKE '%pre-readiness%'
                OR content ILIKE '%confirmed home access%'
              )
            RETURNING id
          )
          SELECT
            (SELECT COUNT(*)::int FROM deleted_events) AS deleted_events_count,
            (SELECT COUNT(*)::int FROM deleted_messages) AS deleted_messages_count
        `,
        [id]
      );

      await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, {
        messageId: `precheck-reset-${Date.now()}`,
        appointmentId: id,
        trigger: 'MANUAL',
        timestamp: new Date().toISOString(),
        payload: { id },
      });

      const row = resetResult.rows[0];
      res.json({
        success: true,
        data: {
          appointmentId: id,
          deletedReadinessEvents: row?.deleted_events_count || 0,
          deletedPrecheckMessages: row?.deleted_messages_count || 0,
          requeuedReadinessEvaluation: true,
        },
      });
    } catch (error) {
      console.error('Failed to reset precheck', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /precheck/debug-candidates
  // Returns appointments currently eligible for auto-precheck kickoff.
  app.get('/precheck/debug-candidates', async (req: Request, res: Response) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.trunc(rawLimit))) : 50;

      const result = await pool.query(
        `
          WITH ranked AS (
            SELECT
              a.id,
              a.client_id,
              c.name AS client_name,
              a.start_time,
              (a.start_time AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date AS appointment_date,
              a.service_type,
              COALESCE(a.aloha_status, 'SCHEDULED') AS appointment_status,
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
            r.client_name,
            r.start_time,
            r.appointment_date,
            r.service_type,
            r.appointment_status
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
        [limit]
      );

      res.json({
        success: true,
        data: result.rows.map((row) => ({
          appointmentId: row.appointment_id,
          clientName: row.client_name,
          appointmentDate: String(row.appointment_date),
          appointmentStartTime: row.start_time,
          appointmentStatus: row.appointment_status,
          serviceType: row.service_type,
        })),
      });
    } catch (error) {
      console.error('Failed to fetch precheck debug candidates', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /precheck/reset-all
  // Clears precheck markers globally, then re-queues readiness evaluation for next upcoming scheduled appointment per client.
  app.post('/precheck/reset-all', async (_req: Request, res: Response) => {
    try {
      const resetResult = await pool.query(
        `
          WITH deleted_events AS (
            DELETE FROM readiness_events
            WHERE event_type IN ('PRECHECK_STARTED', 'PRECHECK_COMPLETED', 'PRECHECK_PLANNER')
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM messages
            WHERE sender_type = 'AI_AGENT'
              AND (
                content ILIKE 'Hi %care team assistant%'
                OR content ILIKE '%pre-readiness%'
                OR content ILIKE '%confirmed home access%'
              )
            RETURNING id
          )
          SELECT
            (SELECT COUNT(*)::int FROM deleted_events) AS deleted_events_count,
            (SELECT COUNT(*)::int FROM deleted_messages) AS deleted_messages_count
        `
      );

      const latestRes = await pool.query(
        `
          WITH ranked AS (
            SELECT
              a.id,
              a.client_id,
              a.start_time,
              ROW_NUMBER() OVER (
                PARTITION BY a.client_id
                ORDER BY a.start_time ASC, a.id ASC
              ) AS rn
            FROM appointments a
            WHERE COALESCE(a.aloha_status, 'SCHEDULED') = 'SCHEDULED'
              AND a.caregiver_id IS NOT NULL
              AND a.start_time > NOW()
          )
          SELECT r.id::text AS appointment_id
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
        `
      );

      const queued: string[] = [];
      for (const row of latestRes.rows) {
        const appointmentId = String(row.appointment_id);
        await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, {
          messageId: `precheck-reset-all-${Date.now()}-${appointmentId.slice(0, 8)}`,
          appointmentId,
          trigger: 'MANUAL',
          timestamp: new Date().toISOString(),
          payload: { id: appointmentId },
        });
        queued.push(appointmentId);
      }

      const row = resetResult.rows[0];
      res.json({
        success: true,
        data: {
          deletedReadinessEvents: row?.deleted_events_count || 0,
          deletedPrecheckMessages: row?.deleted_messages_count || 0,
          requeuedAppointments: queued.length,
          appointmentIds: queued,
        },
      });
    } catch (error) {
      console.error('Failed to reset all prechecks', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /messages
  app.post('/messages', async (req: Request, res: Response) => {
    try {
      const sessionUser = getSessionUser(req);
      const { appointmentId, content, senderType, senderId } = req.body;
      const finalSenderType = senderType || sessionUser?.role || 'CAREGIVER';
      const finalSenderId = senderId || sessionUser?.userId || 'CG-DEMO-USER';

      const dbResult = await pool.query(`
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1, $2, $3, $4, false)
        RETURNING id, created_at
      `, [appointmentId, finalSenderType, finalSenderId, content]);

      const newMessage = dbResult.rows[0];

      await publishMessage(sqsClient, QUEUES.INCOMING_MESSAGES, {
        type: 'NEW_MESSAGE',
        appointmentId,
        text: content,
        senderType: finalSenderType,
        senderId: finalSenderId,
        messageId: newMessage.id
      });

      res.json({ success: true, data: newMessage });
    } catch (error) {
      console.error('Failed to send message', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/messages
  app.get('/appointments/:id/messages', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const sessionUser = getSessionUser(req);
      const role = String(sessionUser?.role || req.query.role || '').toUpperCase();
      const isCareTeamViewer = role === 'CAREGIVER' || role === 'COORDINATOR';

      const result = await pool.query(
        `
          SELECT *
          FROM messages
          WHERE appointment_id = $1
            AND ($2::boolean = true OR sender_type <> 'SYSTEM')
          ORDER BY created_at ASC
        `,
        [id, isCareTeamViewer]
      );
      res.json({ data: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /agents/:userId/status
  // Fetches the current status of a user's digital twin
  app.get('/agents/:userId/status', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const result = await pool.query(
        `SELECT status FROM user_agents WHERE user_id = $1`, 
        [userId]
      );
      
      const status = result.rows[0]?.status || 'ACTIVE'; // Default to active
      res.json({ status });
    } catch (error) {
      console.error('Failed to fetch agent status', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // PUT /agents/:userId/status
  // Manually overrides the AI status (ON/OFF)
  app.put('/agents/:userId/status', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { status } = req.body; // 'ACTIVE' or 'PAUSED'

      await pool.query(`
        INSERT INTO user_agents (user_id, role, status, paused_until)
        VALUES ($1, 'CAREGIVER', $2, NULL)
        ON CONFLICT (user_id) 
        DO UPDATE SET status = $2, paused_until = NULL
      `, [userId, status]);

      res.json({ success: true, status });
    } catch (error) {
      console.error('Failed to update agent status', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /agents/:userId/delegations
  // Returns all active delegations for the caregiver
  app.get('/agents/:userId/delegations', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { settings } = await getAgentSettings(userId);
      const delegations = Object.values(settings.delegations || {});
      const now = new Date().toISOString();

      const active = delegations.filter((d) => d.active && d.endsAt > now);
      if (active.length === 0) {
        return res.json({ data: [] });
      }

      const ids = active.map((d) => d.appointmentId);
      const apptRes = await pool.query(
        `
          SELECT a.id, a.start_time, c.name AS client_name
          FROM appointments a
          LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.id = ANY($1::uuid[])
        `,
        [ids]
      );
      const apptMap = new Map(apptRes.rows.map((r) => [r.id, r]));

      res.json({
        data: active
          .map((d) => ({
            ...d,
            appointmentStartTime: apptMap.get(d.appointmentId)?.start_time || null,
            clientName: apptMap.get(d.appointmentId)?.client_name || null,
          }))
          .sort((a, b) => String(b.appointmentStartTime || '').localeCompare(String(a.appointmentStartTime || ''))),
      });
    } catch (error) {
      console.error('Failed to fetch delegations', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /agents/:userId/delegations/start
  // Starts a time-boxed delegation for an appointment
  app.post('/agents/:userId/delegations/start', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { appointmentId, objective, durationMinutes, questions, forceStart } = req.body;

      if (!appointmentId || !objective || !durationMinutes) {
        return res.status(400).json({ error: 'appointmentId, objective, durationMinutes are required' });
      }
      const startResult = await startDelegationWindow({
        userId,
        appointmentId: String(appointmentId),
        objective: String(objective),
        durationMinutes: Number(durationMinutes),
        questions: Array.isArray(questions) ? questions : [],
        forceStart: Boolean(forceStart),
      });
      if (!startResult.ok) {
        if (startResult.status === 409) {
          return res.status(409).json({
            error: startResult.error,
            failedChecks: startResult.failedChecks,
          });
        }
        return res.status(startResult.status).json({ error: startResult.error });
      }

      res.json({ success: true, data: startResult.delegation });
    } catch (error) {
      console.error('Failed to start delegation', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /agents/:userId/command
  // Conversational assistant interface for Agent Desk.
  app.post('/agents/:userId/command', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const rawCommand = String(req.body.command || req.body.text || '').trim();
      const requestedAppointmentId = String(req.body.appointmentId || '').trim();
      const forceStart = Boolean(req.body.forceStart);
      const requestedDuration = Number(req.body.durationMinutes);
      const toolTrace: AgentToolTraceEntry[] = [];
      const withToolTrace = <T extends Record<string, any>>(data: T): T & { toolTrace: AgentToolTraceEntry[] } => ({
        ...data,
        toolTrace,
      });
      const appointmentSearchLimit = clampInteger(
        req.body.searchLimits?.appointmentLimit ?? req.body.appointmentSearchLimit,
        1,
        120,
        CLIENT_LOOKUP_DEFAULT_APPOINTMENT_LIMIT,
      );
      const messageSearchLimit = clampInteger(
        req.body.searchLimits?.messageLimit ?? req.body.messageSearchLimit,
        20,
        600,
        CLIENT_LOOKUP_DEFAULT_MESSAGE_LIMIT,
      );
      const responseSnippetLimit = clampInteger(
        req.body.searchLimits?.snippetLimit ?? req.body.snippetLimit,
        1,
        8,
        CLIENT_LOOKUP_DEFAULT_SNIPPET_LIMIT,
      );

      if (!rawCommand) {
        return res.status(400).json({ error: 'command is required' });
      }

      const { settings, role } = await getAgentSettings(userId);
      let assistantState = appendAssistantTurn(getAssistantState(settings), 'CAREGIVER', rawCommand);
      const persistAssistantState = async () => {
        settings.assistant = assistantState;
        await saveAgentSettings(userId, role || 'CAREGIVER', settings);
      };

      if (!assistantState.pending && looksLikeGreeting(rawCommand)) {
        const responseText = 'Hi. I can help with your schedule, route timing, client history, or delegation follow-ups. What do you want first?';
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: responseText,
          }),
        });
      }

      if (!assistantState.pending && looksLikeAcknowledgement(rawCommand)) {
        const responseText = 'Tell me what you want to do next, and I will handle it.';
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: responseText,
          }),
        });
      }

      if (isCancellationMessage(rawCommand) && assistantState.pending) {
        assistantState = clearAssistantPending(assistantState);
        const responseText = 'Understood. I cancelled that in-progress request. What do you want to do next?';
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: responseText,
          }),
        });
      }

      const commandForPlanning = combineCommandWithPending(assistantState, rawCommand);
      const dateHintFromCommand = parseBusinessDateHint(rawCommand);
      if (dateHintFromCommand) {
        assistantState = {
          ...assistantState,
          memory: {
            ...(assistantState.memory || {}),
            businessDateHint: dateHintFromCommand,
          },
        };
      }

      const scheduleAllStartMs = Date.now();
      const appointments = await loadCaregiverAppointments(userId);
      recordToolTrace(toolTrace, {
        tool: 'schedule.get_all',
        source: 'postgres',
        startedAtMs: scheduleAllStartMs,
        ok: true,
      });

      let plannerDecision: AssistantPlannerDecision | null = null;
      const plannerStartMs = Date.now();
      try {
        plannerDecision = await planAssistantDecisionWithLLM({
          userId,
          command: commandForPlanning,
          assistantState,
          appointments,
          requestedAppointmentId: requestedAppointmentId || undefined,
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.plan_decision',
          source: 'openai_chat_completions',
          startedAtMs: plannerStartMs,
          ok: Boolean(plannerDecision),
          errorCode: plannerDecision ? undefined : 'EMPTY_PLAN',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordToolTrace(toolTrace, {
          tool: 'assistant.plan_decision',
          source: 'openai_chat_completions',
          startedAtMs: plannerStartMs,
          ok: false,
          errorCode: 'UPSTREAM_UNAVAILABLE',
          message,
        });
      }

      const intentHint = detectAgentCommandIntent(commandForPlanning);
      if (!plannerDecision) {
        if (intentHint === 'SCHEDULE_OVERVIEW') {
          plannerDecision = { action: 'USE_TOOL', tool: 'SCHEDULE_DAY' };
        } else if (intentHint === 'MAPS_ROUTE') {
          plannerDecision = { action: 'USE_TOOL', tool: 'MAPS_ROUTE' };
        } else if (intentHint === 'START_DELEGATION') {
          plannerDecision = { action: 'USE_TOOL', tool: 'START_DELEGATION' };
        } else if (intentHint === 'LOOKUP_ACCESS_CODE' || intentHint === 'CLIENT_INFO_LOOKUP') {
          plannerDecision = {
            action: 'USE_TOOL',
            tool: 'CLIENT_INFO',
            infoQuestion: rawCommand,
          };
        } else {
          plannerDecision = {
            action: 'RESPOND',
            response: 'I can help with schedule, routing, client-history questions, and delegation. Tell me what you need and I will handle it step by step.',
          };
        }
      }

      const pickTargetAppointment = (commandForResolution: string): CaregiverAppointmentRow | null => {
        const resolveStartMs = Date.now();
        const target = pickAppointmentForConversation({
          appointments,
          command: commandForResolution,
          requestedAppointmentId: requestedAppointmentId || undefined,
          memory: assistantState.memory,
        });
        recordToolTrace(toolTrace, {
          tool: 'appointment.resolve_target',
          source: 'in_memory',
          startedAtMs: resolveStartMs,
          ok: Boolean(target),
          errorCode: target ? undefined : 'NOT_FOUND',
          message: target ? undefined : 'Could not map request to a specific patient visit.',
        });
        return target;
      };

      if (
        assistantState.pending &&
        plannerDecision.action === 'RESPOND' &&
        shouldMergeWithPending(assistantState, rawCommand) &&
        !isCancellationMessage(rawCommand)
      ) {
        plannerDecision = {
          action: 'USE_TOOL',
          tool: assistantState.pending.tool,
          infoQuestion:
            assistantState.pending.tool === 'CLIENT_INFO'
              ? combineCommandWithPending(assistantState, rawCommand)
              : undefined,
          objective:
            assistantState.pending.tool === 'START_DELEGATION'
              ? combineCommandWithPending(assistantState, rawCommand)
              : undefined,
        };
      }

      if (plannerDecision.action === 'ASK_FOLLOW_UP') {
        const followUpTool = inferToolForFollowUp(plannerDecision, assistantState, commandForPlanning);
        const followUpText =
          plannerDecision.followUpQuestion ||
          'Can you clarify which visit or details you want me to use before I proceed?';

        const pendingBase = assistantState.pending?.baseCommand || rawCommand;
        if (followUpTool === 'MAPS_ROUTE' || assistantState.pending?.kind === 'MAPS_HOME_ADDRESS') {
          assistantState = setAssistantPending(assistantState, {
            kind: 'MAPS_HOME_ADDRESS',
            tool: 'MAPS_ROUTE',
            baseCommand: pendingBase,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
          });
        } else if (followUpTool === 'CLIENT_INFO' || assistantState.pending?.kind === 'CLIENT_INFO_CONTEXT') {
          assistantState = setAssistantPending(assistantState, {
            kind: 'CLIENT_INFO_CONTEXT',
            tool: 'CLIENT_INFO',
            baseCommand: pendingBase,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
          });
        } else if (followUpTool === 'START_DELEGATION' || assistantState.pending?.kind === 'DELEGATION_CONTEXT') {
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_CONTEXT',
            tool: 'START_DELEGATION',
            baseCommand: pendingBase,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
          });
        }

        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', followUpText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'FOLLOW_UP',
            response: followUpText,
          }),
        });
      }

      if (plannerDecision.action === 'RESPOND' || !plannerDecision.tool) {
        const directReplyStartMs = Date.now();
        const directReply = await generateAssistantDirectResponseWithLLM({
          command: rawCommand,
          assistantState,
          appointments,
          plannerHint: plannerDecision.response,
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.respond_freeform',
          source: config.openai.apiKey ? 'openai_chat_completions' : 'disabled',
          startedAtMs: directReplyStartMs,
          ok: true,
        });

        const responseText =
          directReply ||
          plannerDecision.response ||
          'I can help with your schedule, routes, client context, and delegation workflows. What should I handle first?';
        assistantState = { ...assistantState, pending: undefined };
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: responseText,
          }),
        });
      }

      if (plannerDecision.tool === 'SCHEDULE_DAY') {
        const businessDate = getCurrentBusinessDateIso();
        const scheduleStartMs = Date.now();
        const todayAppointments = await loadCaregiverAppointments(userId, { businessDate });
        recordToolTrace(toolTrace, {
          tool: 'schedule.get_day',
          source: 'postgres',
          startedAtMs: scheduleStartMs,
          ok: true,
        });

        const responseText = buildScheduleOverviewResponse(todayAppointments);
        assistantState = clearAssistantPending(assistantState);
        assistantState = {
          ...assistantState,
          memory: {
            ...(assistantState.memory || {}),
            businessDateHint: businessDate,
          },
        };
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: responseText,
            schedule: todayAppointments,
          }),
        });
      }

      if (plannerDecision.tool === 'MAPS_ROUTE') {
        const mapsStartMs = Date.now();
        try {
          const baseCommand = combineCommandWithPending(assistantState, rawCommand);
          const plan = await buildMapsDayPlan({
            userId,
            command: baseCommand,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId || undefined,
            homeAddressOverride:
              plannerDecision.homeAddress || String(req.body.homeAddress || '').trim(),
          });
          recordToolTrace(toolTrace, {
            tool: 'maps.plan_day',
            source: 'google_maps_distance_matrix',
            startedAtMs: mapsStartMs,
            ok: true,
          });

          if (plan.needsHomeAddress) {
            assistantState = setAssistantPending(assistantState, {
              kind: 'MAPS_HOME_ADDRESS',
              tool: 'MAPS_ROUTE',
              baseCommand,
              requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
            });
            assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', plan.response);
            await persistAssistantState();
            return res.json({
              success: true,
              data: withToolTrace({
                mode: 'FOLLOW_UP',
                response: plan.response,
                resolvedAppointment: plan.resolvedAppointment,
              }),
            });
          }

          assistantState = clearAssistantPending(assistantState);
          assistantState = updateAssistantMemoryFromResolved(
            assistantState,
            plan.resolvedAppointment || null,
            parseBusinessDateHint(rawCommand),
          );
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', plan.response);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'ANSWERED',
              response: plan.response,
              resolvedAppointment: plan.resolvedAppointment,
              route: {
                provider: 'GOOGLE_MAPS_DISTANCE_MATRIX',
                legs: plan.legs,
              },
            }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordToolTrace(toolTrace, {
            tool: 'maps.plan_day',
            source: 'google_maps_distance_matrix',
            startedAtMs: mapsStartMs,
            ok: false,
            errorCode: 'UPSTREAM_UNAVAILABLE',
            message,
          });

          const responseText = `I could not complete the map lookup: ${message}.`;
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'SUGGESTION',
              response: responseText,
            }),
          });
        }
      }

      if (plannerDecision.tool === 'CLIENT_INFO') {
        const infoQuestion = String(plannerDecision.infoQuestion || combineCommandWithPending(assistantState, rawCommand));
        const targetCommand = `${infoQuestion} ${plannerDecision.appointmentHint || ''}`.trim();
        const targetAppointment = pickTargetAppointment(targetCommand);
        if (!targetAppointment) {
          const followUp =
            'Which client or visit should I check? You can mention the client name or select a visit first.';
          assistantState = setAssistantPending(assistantState, {
            kind: 'CLIENT_INFO_CONTEXT',
            tool: 'CLIENT_INFO',
            baseCommand: infoQuestion,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
          });
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', followUp);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'FOLLOW_UP',
              response: followUp,
            }),
          });
        }

        const resolvedAppointment = {
          appointmentId: targetAppointment.appointmentId,
          clientId: targetAppointment.clientId,
          clientName: targetAppointment.clientName,
          appointmentStartTime: targetAppointment.startTime,
        };
        const businessDateHint = parseBusinessDateHint(targetCommand) || assistantState.memory?.businessDateHint;

        const lookupStartMs = Date.now();
        const lookup = await lookupClientInfoAcrossMessages({
          userId,
          clientId: targetAppointment.clientId,
          clientName: targetAppointment.clientName,
          question: infoQuestion,
          appointmentLimit: appointmentSearchLimit,
          messageLimit: messageSearchLimit,
          snippetLimit: responseSnippetLimit,
          targetBusinessDate: businessDateHint || undefined,
          specificAppointmentId: requestedAppointmentId || undefined,
        });
        recordToolTrace(toolTrace, {
          tool: 'chat.lookup_client_info',
          source: 'postgres',
          startedAtMs: lookupStartMs,
          ok: true,
        });

        const synthStartMs = Date.now();
        const synthesized = await synthesizeClientInfoAnswer({
          question: infoQuestion,
          clientName: targetAppointment.clientName,
          evidence: lookup.evidence,
          fallback: lookup.response,
        });
        recordToolTrace(toolTrace, {
          tool: 'chat.summarize_answer',
          source: config.openai.apiKey ? 'openai_chat_completions' : 'disabled',
          startedAtMs: synthStartMs,
          ok: true,
        });

        assistantState = clearAssistantPending(assistantState);
        assistantState = updateAssistantMemoryFromAppointment(assistantState, targetAppointment, businessDateHint);
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', synthesized);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: synthesized,
            resolvedAppointment,
            search: {
              appointmentsScanned: lookup.scannedAppointments,
              messagesScanned: lookup.scannedMessages,
              appointmentLimit: appointmentSearchLimit,
              messageLimit: messageSearchLimit,
            },
          }),
        });
      }

      if (plannerDecision.tool === 'START_DELEGATION') {
        const delegationCommand = combineCommandWithPending(assistantState, rawCommand);
        const targetCommand = `${delegationCommand} ${plannerDecision.appointmentHint || ''}`.trim();
        const targetAppointment = pickTargetAppointment(targetCommand);
        if (!targetAppointment) {
          const followUp =
            'Which visit should I delegate? Please give the client name or choose the target appointment.';
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_CONTEXT',
            tool: 'START_DELEGATION',
            baseCommand: delegationCommand,
            requestedAppointmentId: requestedAppointmentId || assistantState.pending?.requestedAppointmentId,
          });
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', followUp);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'FOLLOW_UP',
              response: followUp,
            }),
          });
        }

        const resolvedAppointment = {
          appointmentId: targetAppointment.appointmentId,
          clientId: targetAppointment.clientId,
          clientName: targetAppointment.clientName,
          appointmentStartTime: targetAppointment.startTime,
        };

        const derived = deriveDelegationPlan(delegationCommand);
        const delegationObjective = String(plannerDecision.objective || derived.objective).trim() || derived.objective;
        const delegationQuestions =
          Array.isArray(plannerDecision.questions) && plannerDecision.questions.length > 0
            ? plannerDecision.questions
            : derived.questions;

        const delegationStartMs = Date.now();
        const startResult = await startDelegationWindow({
          userId,
          appointmentId: targetAppointment.appointmentId,
          objective: delegationObjective,
          durationMinutes: Number.isFinite(requestedDuration) ? requestedDuration : 30,
          questions: delegationQuestions,
          forceStart,
        });
        if (!startResult.ok) {
          recordToolTrace(toolTrace, {
            tool: 'delegation.start_window',
            source: 'postgres',
            startedAtMs: delegationStartMs,
            ok: false,
            errorCode: startResult.status === 404 ? 'NOT_FOUND' : 'INVALID_INPUT',
            message: startResult.error,
          });
          if (startResult.status === 409) {
            const responseText = `Critical blockers are still failed for ${targetAppointment.clientName}: ${startResult.failedChecks.join(', ')}. Resolve them or retry with forceStart.`;
            assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
            await persistAssistantState();
            return res.status(409).json({
              error: startResult.error,
              failedChecks: startResult.failedChecks,
              data: withToolTrace({
                mode: 'SUGGESTION',
                response: responseText,
                resolvedAppointment,
              }),
            });
          }
          return res.status(startResult.status).json({ error: startResult.error, toolTrace });
        }
        recordToolTrace(toolTrace, {
          tool: 'delegation.start_window',
          source: 'postgres',
          startedAtMs: delegationStartMs,
          ok: true,
        });

        const responseText = [
          `Started delegation for ${targetAppointment.clientName}.`,
          `Window: ${formatBusinessDateTime(startResult.delegation.startedAt)} to ${formatBusinessDateTime(startResult.delegation.endsAt)}.`,
          startResult.firstQuestion
            ? `First question sent: ${startResult.firstQuestion}`
            : 'A kickoff update was sent to the client.',
        ].join(' ');
        assistantState = clearAssistantPending(assistantState);
        assistantState = updateAssistantMemoryFromAppointment(assistantState, targetAppointment, parseBusinessDateHint(targetCommand));
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', responseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'DELEGATION_STARTED',
            response: responseText,
            resolvedAppointment,
            action: {
              type: 'START_DELEGATION',
              appointmentId: targetAppointment.appointmentId,
              delegation: startResult.delegation,
            },
          }),
        });
      }

      const generic = 'I could not map that to an action. Ask me for schedule, routing, client context, or delegation help.';
      assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', generic);
      await persistAssistantState();
      return res.json({
        success: true,
        data: withToolTrace({
          mode: 'SUGGESTION',
          response: generic,
        }),
      });
    } catch (error) {
      console.error('Failed to process agent command', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /agents/:userId/delegations/:appointmentId/stop
  // Stops delegation and returns a generated summary
  app.post('/agents/:userId/delegations/:appointmentId/stop', async (req: Request, res: Response) => {
    try {
      const { userId, appointmentId } = req.params;
      const { settings, role } = await getAgentSettings(userId);
      const delegations = settings.delegations || {};
      const delegation = delegations[appointmentId];

      if (!delegation) {
        return res.status(404).json({ error: 'Delegation not found for this appointment' });
      }

      if (!delegation.active && delegation.summary && delegation.summaryGeneratedAt) {
        return res.json({ success: true, data: delegation });
      }

      const endedAt = new Date().toISOString();
      const summary = await buildDelegationSummary(appointmentId, delegation.startedAt, endedAt);
      const updated: DelegationEntry = {
        ...delegation,
        active: false,
        endedAt,
        summary,
        summaryGeneratedAt: endedAt,
      };

      delegations[appointmentId] = updated;
      settings.delegations = delegations;
      settings.summaryHistory = dedupeSummaries([
        ...(settings.summaryHistory || []),
        {
          appointmentId,
          objective: delegation.objective,
          questions: delegation.questions || [],
          startedAt: delegation.startedAt,
          endedAt,
          summary,
          summaryGeneratedAt: endedAt,
        },
      ]);
      await saveAgentSettings(userId, role || 'CAREGIVER', settings);

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error('Failed to stop delegation', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /agents/:userId/summaries
  // Returns historical delegation summaries for this caregiver
  app.get('/agents/:userId/summaries', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { settings } = await getAgentSettings(userId);
      const delegations = Object.values(settings.delegations || {});
      const history = settings.summaryHistory || [];

      const merged = [
        ...history,
        ...delegations
          .filter((d) => Boolean(d.summary))
          .map((d) => ({
            appointmentId: d.appointmentId,
            objective: d.objective,
            questions: d.questions || [],
            startedAt: d.startedAt,
            endedAt: d.endedAt || d.endsAt,
            summary: d.summary || '',
            summaryGeneratedAt: d.summaryGeneratedAt || d.endedAt || d.endsAt,
          })),
      ];
      const summaries = dedupeSummaries(merged).sort((a, b) => (b.summaryGeneratedAt || '').localeCompare(a.summaryGeneratedAt || ''));

      if (summaries.length === 0) {
        return res.json({ data: [] });
      }

      const ids = summaries.map((s) => s.appointmentId);
      const apptRes = await pool.query(
        `
          SELECT a.id, a.start_time, c.name AS client_name
          FROM appointments a
          LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.id = ANY($1::uuid[])
        `,
        [ids]
      );
      const nameMap = new Map(apptRes.rows.map((r) => [r.id, r.client_name]));
      const startMap = new Map(apptRes.rows.map((r) => [r.id, r.start_time]));

      const result = summaries.map((s) => ({
        ...s,
        clientName: nameMap.get(s.appointmentId) || 'Unknown Client',
        appointmentStartTime: startMap.get(s.appointmentId) || null,
      }));

      res.json({ data: result });
    } catch (error) {
      console.error('Failed to fetch summaries', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // --- 5. START SERVER ---
  app.listen(PORT, () => {
    console.log(`\n✅ SERVICE IS LIVE ON PORT ${PORT}`);
    console.log(`   👉 Test URL: http://localhost:${PORT}/health`);
    console.log(`   👉 CORS is ENABLED for everyone.\n`);
  });
}

main().catch(console.error);
