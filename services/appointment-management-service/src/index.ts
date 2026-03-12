// services/appointment-management-service/src/index.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { loadConfig } from './config';
import { initializeDatabase, testConnection } from './db';
import { initializeSQS, publishMessage } from './sqs';
import { QUEUES, resolvePrecheckProfile, type NotificationJob, type PrecheckCheckType } from '@ar/types';
import {
  buildScheduleOverviewResponse as buildScheduleOverviewResponsePolicy,
  clampAppointmentIdsByLimit,
  formatBusinessDateLabel as formatBusinessDateLabelPolicy,
  parseBusinessDateHint as parseBusinessDateHintPolicy,
  resolveRequestedBusinessDate as resolveRequestedBusinessDatePolicy,
} from './assistant-policy';
import {
  detectDeterministicTurnSignals,
  type CaregiverTurnSignals,
} from './turn-signal-policy';
import {
  getAgentSettingsVersion,
  withAgentSettingsVersion,
} from './agent-settings-policy';
import {
  shouldUseAiFirstIntent,
  shouldUseLegacyPlannerRecovery,
  shouldUsePlannerRepairHop,
} from './router-policy';
import { buildCaregiverDelegationSummary } from './delegation-summary-policy';
import { hasDelegationIntent, hasExplicitDelegationDirective } from './delegation-intent-policy';
import {
  applyRouterContractDefaults,
  normalizeRequiredSlots,
  normalizeResponseStyle,
  type RouterRequiredSlot,
  type RouterResponseStyle,
} from './router-contract-policy';
import {
  buildAgentDeskTurnDedupeKey,
  compileDelegationContext,
  inferDelegationTypeFromCommand,
  type DelegationContextPacket,
  type DelegationContextHistoryLine,
  type DelegationQuestionItem,
  type DelegationType,
} from './delegation-context-compiler';

// --- 1. SETUP & CONFIG ---
const config = loadConfig();
const PORT = config.port;

type DelegationEntry = {
  appointmentId: string;
  active: boolean;
  objective: string;
  questions: string[];
  questionItems?: DelegationQuestionItem[];
  primaryQuestionIndexes?: number[];
  optionalQuestionIndexes?: number[];
  delegationType?: DelegationType;
  factCheckClarificationAsked?: boolean;
  askedQuestionIndexes?: number[];
  resolvedQuestionIndexes?: number[];
  progressNotifiedIndexes?: number[];
  completionNotifiedAt?: string;
  contextPacket?: DelegationContextPacket;
  startedAt: string;
  endsAt: string;
  endedAt?: string;
  summary?: string;
  summaryGeneratedAt?: string;
  source?: string;
  systemManaged?: boolean;
  precheckProfileId?: string;
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

type AgentPersonaSettingsMeta = {
  version?: number;
};

type AgentPersonaSettings = {
  delegations?: Record<string, DelegationEntry>;
  summaryHistory?: DelegationSummaryRecord[];
  assistant?: AgentAssistantState;
  _meta?: AgentPersonaSettingsMeta;
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
  questionItems?: DelegationQuestionItem[];
  delegationType?: DelegationType;
  forceStart?: boolean;
  contextPacket?: DelegationContextPacket;
};

type StartDelegationResult =
  | {
      ok: true;
      delegation: DelegationEntry;
      firstQuestion: string | null;
      reusedExisting?: boolean;
      appendedQuestionCount?: number;
      newlyAskedQuestions?: string[];
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
  appointmentId?: string;
};

type AgentDeskActorType = 'CAREGIVER' | 'ASSISTANT' | 'SYSTEM';

type AgentDeskMessageRow = {
  id: string;
  caregiverId: string;
  threadId: string;
  appointmentId?: string;
  actorType: AgentDeskActorType;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type EscalationCategory =
  | 'CLIENT_QUESTION_NEEDS_CAREGIVER'
  | 'CAREGIVER_REQUESTS_SCHEDULER'
  | 'PRECHECK_CRITICAL_FAIL';

type EscalationPriority = 'HIGH';

type EscalationStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'ACTION_REQUESTED'
  | 'RESOLVED'
  | 'HANDOFF_TO_CAREGIVER'
  | 'AUTO_CLOSED';

type EscalationSource = 'AGENT_DESK' | 'DELEGATED_CHAT' | 'PRECHECK_AUTOMATION' | 'SYSTEM';

type EscalationResolutionType = 'ANSWER_RELAYED' | 'CAREGIVER_HANDOFF' | 'SCHEDULER_RESOLVED' | 'NO_ACTION';

type EscalationRow = {
  id: string;
  caregiverId: string;
  appointmentId?: string;
  delegationId?: string;
  source: EscalationSource;
  category: EscalationCategory;
  priority: EscalationPriority;
  status: EscalationStatus;
  summary: string;
  context: Record<string, unknown>;
  openedBy: string;
  resolvedBy?: string;
  resolutionType?: string;
  openedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type SchedulerThreadActorType = 'CAREGIVER' | 'COORDINATOR' | 'SYSTEM' | 'AI_AGENT';

type SchedulerThreadMessageRow = {
  id: string;
  threadId: string;
  caregiverId: string;
  senderType: SchedulerThreadActorType;
  senderId?: string;
  content: string;
  escalationId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type AssistantPendingState = {
  kind:
    | 'MAPS_HOME_ADDRESS'
    | 'CLIENT_INFO_CONTEXT'
    | 'DELEGATION_CONTEXT'
    | 'DELEGATION_TARGET_CONTEXT'
    | 'DELEGATION_CONTACT_CONFIRM';
  tool: 'MAPS_ROUTE' | 'CLIENT_INFO' | 'START_DELEGATION';
  baseCommand: string;
  clarifications?: string[];
  requestedAppointmentId?: string;
  createdAt: string;
};

type AssistantMemoryState = {
  clientId?: string;
  clientName?: string;
  lastReferencedClientId?: string;
  lastReferencedClientName?: string;
  appointmentId?: string;
  businessDateHint?: string;
};

type AgentAssistantState = {
  history: AssistantTurn[];
  pending?: AssistantPendingState;
  memory?: AssistantMemoryState;
};

type AssistantPlannerTool = 'SCHEDULE_DAY' | 'MAPS_ROUTE' | 'CLIENT_INFO' | 'START_DELEGATION';
type AssistantRequiredSlot = RouterRequiredSlot;
type AssistantResponseStyle = RouterResponseStyle;

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
  requiredSlots?: AssistantRequiredSlot[];
  responseStyle?: AssistantResponseStyle;
};

type MissingInfoPolicyAction = 'ANSWER_FROM_KNOWN_INFO' | 'ACQUIRE_MISSING_INFO';

type MissingInfoPolicyDecision = {
  action: MissingInfoPolicyAction;
  confidence: number;
  rationale: string;
};

type AuthRole = 'CAREGIVER' | 'FAMILY' | 'COORDINATOR';

type SessionUser = {
  userId: string;
  role: AuthRole;
  displayName: string;
  username: string;
};

type AppointmentScopeRow = {
  appointmentId: string;
  caregiverId: string;
  clientId: string;
  startTime: string;
};

class SettingsVersionConflictError extends Error {
  constructor(message: string = 'Agent settings version conflict') {
    super(message);
    this.name = 'SettingsVersionConflictError';
  }
}

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
const PRECHECK_CRITICAL_CHECK_ORDER: PrecheckCheckType[] = [
  'ACCESS_CONFIRMED',
  'MEDS_SUPPLIES_READY',
  'CARE_PLAN_CURRENT',
];
const ESCALATION_CATEGORIES = new Set<EscalationCategory>([
  'CLIENT_QUESTION_NEEDS_CAREGIVER',
  'CAREGIVER_REQUESTS_SCHEDULER',
  'PRECHECK_CRITICAL_FAIL',
]);
const ESCALATION_STATUSES = new Set<EscalationStatus>([
  'OPEN',
  'ACKNOWLEDGED',
  'ACTION_REQUESTED',
  'RESOLVED',
  'HANDOFF_TO_CAREGIVER',
  'AUTO_CLOSED',
]);
const ESCALATION_SOURCES = new Set<EscalationSource>([
  'AGENT_DESK',
  'DELEGATED_CHAT',
  'PRECHECK_AUTOMATION',
  'SYSTEM',
]);
const ESCALATION_RESOLUTION_TYPES = new Set<EscalationResolutionType>([
  'ANSWER_RELAYED',
  'CAREGIVER_HANDOFF',
  'SCHEDULER_RESOLVED',
  'NO_ACTION',
]);
const PENDING_CLARIFICATION_MAX_ITEMS = 4;
const BUSINESS_TIME_ZONE = 'America/Los_Angeles';
const SQL_APPOINTMENT_BUSINESS_DATE = `(a.start_time AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;
const SQL_START_TIME_BUSINESS_DATE = `(start_time AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;
const CLIENT_LOOKUP_DEFAULT_APPOINTMENT_LIMIT = 20;
const CLIENT_LOOKUP_DEFAULT_MESSAGE_LIMIT = 400;
const CLIENT_LOOKUP_DEFAULT_SNIPPET_LIMIT = 4;
const CLIENT_LOOKUP_LLM_CANDIDATE_LIMIT = 120;
const LOCAL_COORDINATOR_FALLBACK_RAW = String(process.env.ALLOW_LOCAL_COORDINATOR_FALLBACK || '').trim().toLowerCase();
const LOCAL_COORDINATOR_FALLBACK_ENABLED = LOCAL_COORDINATOR_FALLBACK_RAW
  ? ['1', 'true', 'yes'].includes(LOCAL_COORDINATOR_FALLBACK_RAW)
  : process.env.NODE_ENV !== 'production';
const LOCAL_COORDINATOR_USERNAME = String(process.env.LOCAL_COORDINATOR_USERNAME || 'scheduler-local').trim() || 'scheduler-local';
const LOCAL_COORDINATOR_PASSWORD = String(process.env.LOCAL_COORDINATOR_PASSWORD || 'demo123');
const LOCAL_COORDINATOR_USER_ID_CANDIDATE =
  String(process.env.LOCAL_COORDINATOR_USER_ID || '00000000-0000-0000-0000-000000000004').trim() ||
  '00000000-0000-0000-0000-000000000004';
const LOCAL_COORDINATOR_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
  LOCAL_COORDINATOR_USER_ID_CANDIDATE,
)
  ? LOCAL_COORDINATOR_USER_ID_CANDIDATE
  : '00000000-0000-0000-0000-000000000004';
const LOCAL_COORDINATOR_DISPLAY_NAME =
  String(process.env.LOCAL_COORDINATOR_DISPLAY_NAME || 'Scheduler').trim() || 'Scheduler';

function isSystemManagedDelegationEntry(entry: DelegationEntry | null | undefined): boolean {
  if (!entry) return false;
  return entry.systemManaged === true || String(entry.source || '').toUpperCase() === 'PRECHECK_AUTOMATION';
}

async function main() {
  console.log('[STARTUP] 🚀 Initializing Service...');

  // --- 2. DATABASE ---
  const pool = initializeDatabase(config.database);
  await testConnection(pool);
  const sqsClient = initializeSQS(config.sqs);

  // --- 3. SERVER & CORS (THE FIX) ---
  const app = express();
  app.set('trust proxy', true);

  // A. The Package
  app.use(cors());

  // B. The Manual Override (Nuclear Option)
  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`); // Log every hit!
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Twilio-Signature",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    next();
  });

  app.use(express.urlencoded({ extended: false }));
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

  async function loadAppointmentScope(appointmentId: string): Promise<AppointmentScopeRow | null> {
    const result = await pool.query(
      `
        SELECT
          id::text AS appointment_id,
          caregiver_id::text AS caregiver_id,
          client_id::text AS client_id,
          start_time::text AS start_time
        FROM appointments
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [appointmentId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      appointmentId: String(row.appointment_id || ''),
      caregiverId: String(row.caregiver_id || ''),
      clientId: String(row.client_id || ''),
      startTime: String(row.start_time || ''),
    };
  }

  function canSessionAccessAppointment(sessionUser: SessionUser, scope: AppointmentScopeRow): boolean {
    if (sessionUser.role === 'COORDINATOR') return true;
    if (sessionUser.role === 'CAREGIVER') {
      return sessionUser.userId === scope.caregiverId;
    }
    if (sessionUser.role === 'FAMILY') {
      return sessionUser.userId === scope.clientId;
    }
    return false;
  }

  function senderTypeForSessionRole(role: AuthRole): 'CAREGIVER' | 'FAMILY' | 'COORDINATOR' {
    if (role === 'FAMILY') return 'FAMILY';
    if (role === 'COORDINATOR') return 'COORDINATOR';
    return 'CAREGIVER';
  }

  function normalizeWhatsAppEndpoint(value: unknown): string {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.toLowerCase().startsWith('whatsapp:')) {
      raw = raw.slice('whatsapp:'.length).trim();
    }
    raw = raw.replace(/[\s()-]/g, '');
    if (/^\d+$/.test(raw)) {
      raw = `+${raw}`;
    }
    if (!/^\+\d{7,15}$/.test(raw)) return '';
    return raw;
  }

  function buildFullRequestUrl(req: Request): string {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0]?.trim();
    return `${protocol}://${host}${req.originalUrl}`;
  }

  function computeTwilioSignature(
    authToken: string,
    url: string,
    params: Record<string, string>,
  ): string {
    const sortedKeys = Object.keys(params).sort();
    const payload = sortedKeys.reduce((acc, key) => `${acc}${key}${params[key]}`, url);
    return crypto.createHmac('sha1', authToken).update(payload).digest('base64');
  }

  function isValidTwilioSignature(req: Request): boolean {
    if (!config.whatsapp.twilioAuthToken) return false;
    const expectedHeader = String(req.header('X-Twilio-Signature') || '').trim();
    if (!expectedHeader) return false;

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      normalized[key] = Array.isArray(value)
        ? value.map((item) => String(item ?? '')).join('')
        : String(value);
    }

    const requestUrl = buildFullRequestUrl(req);
    const computed = computeTwilioSignature(config.whatsapp.twilioAuthToken, requestUrl, normalized);
    const left = Buffer.from(computed);
    const right = Buffer.from(expectedHeader);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  }

  function sendTwilioXmlAck(res: Response): void {
    res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  function isWhatsAppAllowlisted(endpoint: string): boolean {
    if (!config.whatsapp.trialMode && config.whatsapp.allowlistNumbers.length === 0) return true;
    if (config.whatsapp.allowlistNumbers.length === 0) return true;
    const allowlist = new Set(config.whatsapp.allowlistNumbers.map((item) => normalizeWhatsAppEndpoint(item)).filter(Boolean));
    return allowlist.has(endpoint);
  }

  function metric(name: string, fields: Record<string, unknown>): void {
    console.log('[METRIC]', JSON.stringify({ scope: 'whatsapp', name, ...fields }));
  }

  const WHATSAPP_KICKOFF_SUPPRESS_MINUTES = 60;

  function redactPhoneForLogs(endpoint: string): string {
    const normalized = normalizeWhatsAppEndpoint(endpoint);
    if (!config.whatsapp.redactLogs) return normalized || String(endpoint || '');
    if (!normalized) return 'unknown';
    return `${normalized.slice(0, 3)}***${normalized.slice(-2)}`;
  }

  type WhatsAppEndpointBinding = {
    clientId: string;
    verified: boolean;
    active: boolean;
    blocked: boolean;
    metadata: Record<string, unknown>;
  };

  async function resolveWhatsAppEndpointBinding(endpoint: string): Promise<WhatsAppEndpointBinding | null> {
    const result = await pool.query(
      `
        SELECT
          entity_id::text AS entity_id,
          verified,
          active,
          metadata
        FROM channel_endpoints
        WHERE provider = 'twilio_whatsapp'
          AND endpoint = $1
          AND entity_type = 'CLIENT'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [endpoint],
    );
    if (!result.rows[0]?.entity_id) return null;
    const metadata = (result.rows[0].metadata || {}) as Record<string, unknown>;
    const blockedRaw = String(metadata.blocked || '').trim().toLowerCase();
    const blocked = blockedRaw === '1' || blockedRaw === 'true' || blockedRaw === 'yes';
    return {
      clientId: String(result.rows[0].entity_id || ''),
      verified: Boolean(result.rows[0].verified),
      active: Boolean(result.rows[0].active),
      blocked,
      metadata,
    };
  }

  async function isRateLimitedEndpoint(endpoint: string): Promise<boolean> {
    const limit = config.whatsapp.rateLimitPerEndpoint;
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const result = await pool.query(
      `
        SELECT COUNT(*)::int AS recent_count
        FROM webhook_inbox_events
        WHERE provider = 'twilio_whatsapp'
          AND created_at >= NOW() - INTERVAL '1 minute'
          AND COALESCE(payload->>'fromEndpoint', '') = $1
      `,
      [endpoint],
    );
    const recentCount = Number(result.rows[0]?.recent_count || 0);
    return recentCount >= limit;
  }

  async function resolvePrimaryVerifiedWhatsAppEndpointForClient(clientId: string): Promise<string | null> {
    const endpointRes = await pool.query(
      `
        SELECT endpoint
        FROM channel_endpoints
        WHERE provider = 'twilio_whatsapp'
          AND entity_type = 'CLIENT'
          AND entity_id = $1::uuid
          AND active = true
          AND verified = true
          AND COALESCE(metadata->>'blocked', 'false') NOT IN ('true', '1', 'yes')
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [clientId],
    );
    return endpointRes.rows[0]?.endpoint ? String(endpointRes.rows[0].endpoint) : null;
  }

  async function fanoutKickoffToWhatsApp(input: {
    appointmentId: string;
    clientId: string;
    kickoffType: 'DELEGATION' | 'PRECHECK';
    kickoffMessage: string;
  }): Promise<void> {
    if (!config.whatsapp.enabled) return;

    const toEndpoint = await resolvePrimaryVerifiedWhatsAppEndpointForClient(input.clientId);
    if (!toEndpoint) return;

    const normalizedMessage = input.kickoffMessage.trim().toLowerCase();
    const hash = crypto.createHash('sha1').update(normalizedMessage).digest('hex').slice(0, 16);
    const bucket = Math.floor(Date.now() / (WHATSAPP_KICKOFF_SUPPRESS_MINUTES * 60 * 1000));
    const dedupeKey = `${input.kickoffType}:${input.appointmentId}:${toEndpoint}:${hash}:${bucket}`;

    const dedupeInsert = await pool.query(
      `
        INSERT INTO webhook_inbox_events (
          provider,
          provider_message_id,
          event_type,
          status,
          payload
        )
        VALUES ($1, $2, 'OUTBOUND', 'QUEUED', $3::jsonb)
        ON CONFLICT (provider, provider_message_id) DO NOTHING
        RETURNING id
      `,
      [
        'twilio_whatsapp_kickoff',
        dedupeKey,
        JSON.stringify({
          appointmentId: input.appointmentId,
          toEndpoint,
          kickoffType: input.kickoffType,
        }),
      ],
    );
    if (dedupeInsert.rows.length === 0) return;

    const notification: NotificationJob = {
      type: 'WHATSAPP',
      recipient: toEndpoint,
      templateId: 'WHATSAPP_KICKOFF',
      data: {
        appointmentId: input.appointmentId,
        replyText: input.kickoffMessage,
        kickoffType: input.kickoffType,
      },
      correlationId: dedupeKey,
      provider: 'TWILIO_WHATSAPP',
      fromEndpoint: config.whatsapp.twilioWhatsAppFrom || undefined,
      toEndpoint,
      conversationRef: input.appointmentId,
    };

    try {
      await publishMessage(sqsClient, QUEUES.NOTIFICATION, notification);
      await pool.query(
        `
          UPDATE webhook_inbox_events
          SET status = 'DISPATCHED',
              processed_at = NOW()
          WHERE provider = $1 AND provider_message_id = $2
        `,
        ['twilio_whatsapp_kickoff', dedupeKey],
      );
      metric('kickoff_fanout_dispatched', {
        kickoffType: input.kickoffType,
        toEndpoint: redactPhoneForLogs(toEndpoint),
      });
    } catch (error) {
      await pool.query(
        `
          UPDATE webhook_inbox_events
          SET status = 'FAILED_PROCESSING_RETRYABLE',
              payload = payload || $3::jsonb,
              processed_at = NOW()
          WHERE provider = $1 AND provider_message_id = $2
        `,
        [
          'twilio_whatsapp_kickoff',
          dedupeKey,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        ],
      );
      metric('kickoff_fanout_failed', {
        kickoffType: input.kickoffType,
        toEndpoint: redactPhoneForLogs(toEndpoint),
      });
      console.warn('[WHATSAPP] Kickoff fanout failed (non-blocking)', {
        appointmentId: input.appointmentId,
        kickoffType: input.kickoffType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function resolveOperationalAppointmentForClient(clientId: string): Promise<AppointmentScopeRow | null> {
    const result = await pool.query(
      `
        SELECT
          id::text AS appointment_id,
          caregiver_id::text AS caregiver_id,
          client_id::text AS client_id,
          start_time::text AS start_time
        FROM appointments
        WHERE client_id = $1::uuid
          AND caregiver_id IS NOT NULL
          AND COALESCE(aloha_status, 'SCHEDULED') IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED')
        ORDER BY
          CASE
            WHEN start_time BETWEEN NOW() - INTERVAL '1 day' AND NOW() + INTERVAL '7 days' THEN 0
            ELSE 1
          END,
          CASE WHEN start_time >= NOW() THEN 0 ELSE 1 END,
          ABS(EXTRACT(EPOCH FROM (start_time - NOW()))) ASC
        LIMIT 1
      `,
      [clientId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      appointmentId: String(row.appointment_id || ''),
      caregiverId: String(row.caregiver_id || ''),
      clientId: String(row.client_id || ''),
      startTime: String(row.start_time || ''),
    };
  }

  function authorizeAgentUserAccess(req: Request, res: Response, requestedUserId: string): SessionUser | null {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    if (sessionUser.role === 'COORDINATOR') {
      return sessionUser;
    }
    if (sessionUser.role !== 'CAREGIVER') {
      res.status(403).json({ error: 'Only caregivers or coordinators can access agent endpoints' });
      return null;
    }
    if (sessionUser.userId !== requestedUserId) {
      res.status(403).json({ error: 'Caregivers can only access their own agent workspace' });
      return null;
    }
    return sessionUser;
  }

  function authorizeCoordinatorAccess(req: Request, res: Response): SessionUser | null {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    if (sessionUser.role !== 'COORDINATOR') {
      res.status(403).json({ error: 'Only coordinators can access this endpoint' });
      return null;
    }
    return sessionUser;
  }

  function authorizeSchedulerThreadAccess(req: Request, res: Response, caregiverId: string): SessionUser | null {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    if (sessionUser.role === 'COORDINATOR') return sessionUser;
    if (sessionUser.role !== 'CAREGIVER') {
      res.status(403).json({ error: 'Only caregivers or coordinators can access scheduler threads' });
      return null;
    }
    if (sessionUser.userId !== caregiverId) {
      res.status(403).json({ error: 'Caregivers can only access their own scheduler thread' });
      return null;
    }
    return sessionUser;
  }

  function mapEscalationRow(row: any): EscalationRow {
    return {
      id: String(row.id || ''),
      caregiverId: String(row.caregiver_id || ''),
      appointmentId: normalizeOptionalUuid(row.appointment_id),
      delegationId: String(row.delegation_id || '').trim() || undefined,
      source: String(row.source || 'AGENT_DESK').toUpperCase() as EscalationSource,
      category: String(row.category || 'CAREGIVER_REQUESTS_SCHEDULER').toUpperCase() as EscalationCategory,
      priority: 'HIGH',
      status: String(row.status || 'OPEN').toUpperCase() as EscalationStatus,
      summary: String(row.summary || ''),
      context: (row.context_json || {}) as Record<string, unknown>,
      openedBy: String(row.opened_by || ''),
      resolvedBy: String(row.resolved_by || '').trim() || undefined,
      resolutionType: String(row.resolution_type || '').trim() || undefined,
      openedAt: String(row.opened_at || ''),
      acknowledgedAt: String(row.acknowledged_at || '').trim() || undefined,
      resolvedAt: String(row.resolved_at || '').trim() || undefined,
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }

  function mapSchedulerThreadMessageRow(row: any): SchedulerThreadMessageRow {
    return {
      id: String(row.id || ''),
      threadId: String(row.thread_id || ''),
      caregiverId: String(row.caregiver_id || ''),
      senderType: String(row.sender_type || 'SYSTEM').toUpperCase() as SchedulerThreadActorType,
      senderId: String(row.sender_id || '').trim() || undefined,
      content: String(row.content || ''),
      escalationId: normalizeOptionalUuid(row.escalation_id),
      metadata: (row.metadata_json || {}) as Record<string, unknown>,
      createdAt: String(row.created_at || ''),
    };
  }

  function canTransitionEscalationStatus(from: EscalationStatus, to: EscalationStatus): boolean {
    if (from === to) return true;
    if (from === 'OPEN') {
      return ['ACKNOWLEDGED', 'RESOLVED', 'HANDOFF_TO_CAREGIVER', 'AUTO_CLOSED'].includes(to);
    }
    if (from === 'ACKNOWLEDGED') {
      return ['ACTION_REQUESTED', 'RESOLVED', 'HANDOFF_TO_CAREGIVER', 'AUTO_CLOSED'].includes(to);
    }
    if (from === 'ACTION_REQUESTED') {
      return ['RESOLVED', 'HANDOFF_TO_CAREGIVER'].includes(to);
    }
    return false;
  }

  async function getAgentSettings(userId: string): Promise<{ settings: AgentPersonaSettings; role: string; version: number }> {
    const result = await pool.query(
      `SELECT role, persona_settings FROM user_agents WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return { settings: {}, role: 'CAREGIVER', version: 0 };
    }

    const settings = (result.rows[0].persona_settings || {}) as AgentPersonaSettings;
    return {
      role: result.rows[0].role || 'CAREGIVER',
      settings,
      version: getAgentSettingsVersion(settings),
    };
  }

  async function saveAgentSettings(
    userId: string,
    role: string,
    settings: AgentPersonaSettings,
    options?: { activateAgent?: boolean; expectedVersion?: number }
  ): Promise<number> {
    const activateAgent = Boolean(options?.activateAgent);
    const expectedVersionRaw = options?.expectedVersion;
    const hasExpectedVersion = Number.isFinite(Number(expectedVersionRaw));
    const expectedVersion = hasExpectedVersion
      ? Math.max(0, Math.trunc(Number(expectedVersionRaw)))
      : getAgentSettingsVersion(settings);
    const nextVersion = expectedVersion + 1;
    const versionedSettings = withAgentSettingsVersion(settings, nextVersion);

    if (!hasExpectedVersion) {
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
        [userId, role, JSON.stringify(versionedSettings)]
      );
      return nextVersion;
    }

    const result = await pool.query(
      `
        INSERT INTO user_agents (user_id, role, status, paused_until, persona_settings)
        VALUES ($1, $2, 'ACTIVE', NULL, $3::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          role = EXCLUDED.role,
          persona_settings = EXCLUDED.persona_settings
          ${activateAgent ? ", status = 'ACTIVE', paused_until = NULL" : ''}
        WHERE COALESCE((user_agents.persona_settings->'_meta'->>'version')::bigint, 0) = $4::bigint
        RETURNING user_id
      `,
      [userId, role, JSON.stringify(versionedSettings), expectedVersion],
    );
    if (result.rowCount === 0) {
      throw new SettingsVersionConflictError();
    }
    return nextVersion;
  }

  function shouldUseAgentDeskPersistence(): boolean {
    return Boolean(config.assistant.agentDeskPersistenceV1) && !agentDeskPersistenceSchemaUnavailable;
  }

  let agentDeskPersistenceSchemaUnavailable = false;
  let agentDeskPersistenceSchemaWarned = false;

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

  function markAgentDeskPersistenceSchemaUnavailable(reason: string): void {
    agentDeskPersistenceSchemaUnavailable = true;
    if (agentDeskPersistenceSchemaWarned) return;
    agentDeskPersistenceSchemaWarned = true;
    console.warn('[AGENT] Agent Desk persistence disabled because schema is unavailable', {
      reason,
      expectedTables: ['agent_desk_threads', 'agent_desk_messages'],
      recovery: 'Run migration and restart service.',
    });
  }

  function normalizeOptionalUuid(value: unknown): string | undefined {
    const trimmed = String(value || '').trim();
    if (!trimmed) return undefined;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
      ? trimmed
      : undefined;
  }

  async function ensureAgentDeskThread(caregiverId: string): Promise<string | null> {
    if (!shouldUseAgentDeskPersistence()) return null;
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
        markAgentDeskPersistenceSchemaUnavailable('ensureAgentDeskThread');
        return null;
      }
      throw error;
    }
  }

  async function appendAgentDeskMessage(input: {
    caregiverId: string;
    actorType: AgentDeskActorType;
    content: string;
    appointmentId?: string;
    source?: string;
    metadata?: Record<string, unknown>;
    dedupeKey?: string;
    createdAt?: string;
  }): Promise<string | null> {
    if (!shouldUseAgentDeskPersistence()) return null;
    const content = String(input.content || '').trim();
    if (!content) return null;

    const threadId = await ensureAgentDeskThread(input.caregiverId);
    if (!threadId) return null;
    const createdAt = String(input.createdAt || '').trim();
    const appointmentId = normalizeOptionalUuid(input.appointmentId);
    const source = String(input.source || 'AGENT_COMMAND').trim() || 'AGENT_COMMAND';
    const metadata = input.metadata || {};
    const dedupeKey = String(input.dedupeKey || '').trim() || null;

    const runInsert = async (appointmentIdValue: string | null) => {
      return pool.query(
        `
          INSERT INTO agent_desk_messages (
            thread_id,
            appointment_id,
            actor_type,
            content,
            source,
            metadata,
            dedupe_key
            ${createdAt ? ', created_at' : ''}
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3,
            $4,
            $5,
            $6::jsonb,
            $7
            ${createdAt ? ', $8::timestamptz' : ''}
          )
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id::text
        `,
        createdAt
          ? [threadId, appointmentIdValue, input.actorType, content, source, JSON.stringify(metadata), dedupeKey, createdAt]
          : [threadId, appointmentIdValue, input.actorType, content, source, JSON.stringify(metadata), dedupeKey],
      );
    };

    try {
      const result = await (async () => {
        try {
          return await runInsert(appointmentId || null);
        } catch (error) {
          if (!appointmentId || !isAgentDeskAppointmentForeignKeyError(error)) {
            throw error;
          }
          console.warn('[AGENT] Ignoring stale appointment id for agent desk message persistence', {
            caregiverId: input.caregiverId,
            appointmentId,
            actorType: input.actorType,
            source,
          });
          return runInsert(null);
        }
      })();

      if (result.rows.length > 0) {
        return String(result.rows[0].id);
      }

      if (!dedupeKey) return null;
      const existing = await pool.query(
        `
          SELECT id::text
          FROM agent_desk_messages
          WHERE dedupe_key = $1
          LIMIT 1
        `,
        [dedupeKey],
      );
      return existing.rows[0]?.id ? String(existing.rows[0].id) : null;
    } catch (error) {
      if (isUndefinedTableError(error)) {
        markAgentDeskPersistenceSchemaUnavailable('appendAgentDeskMessage');
        return null;
      }
      throw error;
    }
  }

  async function listAgentDeskMessages(input: {
    caregiverId: string;
    limit: number;
    before?: string;
  }): Promise<AgentDeskMessageRow[]> {
    if (!shouldUseAgentDeskPersistence()) return [];
    try {
      const threadRes = await pool.query(
        `
          SELECT id::text
          FROM agent_desk_threads
          WHERE caregiver_id = $1
          LIMIT 1
        `,
        [input.caregiverId],
      );
      if (threadRes.rows.length === 0) return [];
      const threadId = String(threadRes.rows[0].id);

      const beforeIso = String(input.before || '').trim();
      const params = beforeIso ? [threadId, input.limit, beforeIso] : [threadId, input.limit];
      const query = beforeIso
        ? `
            SELECT
              m.id::text,
              t.caregiver_id::text AS caregiver_id,
              m.thread_id::text AS thread_id,
              COALESCE(m.appointment_id::text, '') AS appointment_id,
              m.actor_type,
              m.content,
              m.source,
              m.metadata,
              m.created_at::text AS created_at
            FROM agent_desk_messages m
            INNER JOIN agent_desk_threads t ON t.id = m.thread_id
            WHERE m.thread_id = $1::uuid
              AND m.created_at < $3::timestamptz
            ORDER BY m.created_at DESC
            LIMIT $2::int
          `
        : `
            SELECT
              m.id::text,
              t.caregiver_id::text AS caregiver_id,
              m.thread_id::text AS thread_id,
              COALESCE(m.appointment_id::text, '') AS appointment_id,
              m.actor_type,
              m.content,
              m.source,
              m.metadata,
              m.created_at::text AS created_at
            FROM agent_desk_messages m
            INNER JOIN agent_desk_threads t ON t.id = m.thread_id
            WHERE m.thread_id = $1::uuid
            ORDER BY m.created_at DESC
            LIMIT $2::int
          `;
      const result = await pool.query(query, params);
      return result.rows.map((row) => ({
        id: String(row.id || ''),
        caregiverId: String(row.caregiver_id || ''),
        threadId: String(row.thread_id || ''),
        appointmentId: normalizeOptionalUuid(row.appointment_id),
        actorType: String(row.actor_type || 'ASSISTANT').toUpperCase() as AgentDeskActorType,
        content: String(row.content || ''),
        source: String(row.source || 'AGENT_COMMAND'),
        metadata: (row.metadata || {}) as Record<string, unknown>,
        createdAt: String(row.created_at || ''),
      }));
    } catch (error) {
      if (isUndefinedTableError(error)) {
        markAgentDeskPersistenceSchemaUnavailable('listAgentDeskMessages');
        return [];
      }
      throw error;
    }
  }

  async function ensureSchedulerThread(caregiverId: string): Promise<string> {
    const existing = await pool.query(
      `
        SELECT id::text
        FROM scheduler_threads
        WHERE caregiver_id = $1
        LIMIT 1
      `,
      [caregiverId],
    );
    if (existing.rows.length > 0) {
      return String(existing.rows[0].id || '');
    }

    const inserted = await pool.query(
      `
        INSERT INTO scheduler_threads (caregiver_id, active, updated_at)
        VALUES ($1, true, NOW())
        ON CONFLICT (caregiver_id)
        DO UPDATE SET
          active = true,
          updated_at = NOW()
        RETURNING id::text
      `,
      [caregiverId],
    );
    return String(inserted.rows[0].id || '');
  }

  async function appendSchedulerThreadMessage(input: {
    caregiverId: string;
    senderType: SchedulerThreadActorType;
    senderId?: string;
    content: string;
    escalationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SchedulerThreadMessageRow> {
    const content = String(input.content || '').trim();
    if (!content) {
      throw new Error('Scheduler thread message content is required');
    }

    const threadId = await ensureSchedulerThread(input.caregiverId);
    const escalationId = normalizeOptionalUuid(input.escalationId);
    const metadata = input.metadata || {};
    const senderId = String(input.senderId || '').trim() || null;

    const result = await pool.query(
      `
        INSERT INTO scheduler_thread_messages (
          thread_id,
          sender_type,
          sender_id,
          content,
          escalation_id,
          metadata_json
        )
        VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::jsonb)
        RETURNING
          id::text,
          thread_id::text,
          sender_type,
          COALESCE(sender_id::text, '') AS sender_id,
          content,
          COALESCE(escalation_id::text, '') AS escalation_id,
          metadata_json,
          created_at::text
      `,
      [threadId, input.senderType, senderId, content, escalationId || null, JSON.stringify(metadata)],
    );

    await pool.query(
      `
        UPDATE scheduler_threads
        SET updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [threadId],
    );

    return mapSchedulerThreadMessageRow({
      ...result.rows[0],
      caregiver_id: input.caregiverId,
    });
  }

  async function listSchedulerThreadMessages(input: {
    caregiverId: string;
    limit: number;
    before?: string;
  }): Promise<{ threadId: string; messages: SchedulerThreadMessageRow[] }> {
    const threadId = await ensureSchedulerThread(input.caregiverId);
    const beforeIso = String(input.before || '').trim();
    const params = beforeIso ? [threadId, input.limit, beforeIso] : [threadId, input.limit];
    const query = beforeIso
      ? `
          SELECT
            m.id::text,
            m.thread_id::text,
            t.caregiver_id::text AS caregiver_id,
            m.sender_type,
            COALESCE(m.sender_id::text, '') AS sender_id,
            m.content,
            COALESCE(m.escalation_id::text, '') AS escalation_id,
            m.metadata_json,
            m.created_at::text
          FROM scheduler_thread_messages m
          INNER JOIN scheduler_threads t ON t.id = m.thread_id
          WHERE m.thread_id = $1::uuid
            AND m.created_at < $3::timestamptz
          ORDER BY m.created_at DESC
          LIMIT $2::int
        `
      : `
          SELECT
            m.id::text,
            m.thread_id::text,
            t.caregiver_id::text AS caregiver_id,
            m.sender_type,
            COALESCE(m.sender_id::text, '') AS sender_id,
            m.content,
            COALESCE(m.escalation_id::text, '') AS escalation_id,
            m.metadata_json,
            m.created_at::text
          FROM scheduler_thread_messages m
          INNER JOIN scheduler_threads t ON t.id = m.thread_id
          WHERE m.thread_id = $1::uuid
          ORDER BY m.created_at DESC
          LIMIT $2::int
        `;
    const result = await pool.query(query, params);
    return {
      threadId,
      messages: result.rows.map((row) => mapSchedulerThreadMessageRow(row)),
    };
  }

  function listLegacyAgentDeskMessagesFromAssistantHistory(input: {
    caregiverId: string;
    assistantHistory: AssistantTurn[];
    limit: number;
    before?: string;
  }): AgentDeskMessageRow[] {
    const beforeMs = input.before ? Date.parse(input.before) : NaN;
    const hasBefore = Number.isFinite(beforeMs);
    const rows = [...input.assistantHistory]
      .filter((turn) => turn.content.trim().length > 0)
      .filter((turn) => {
        if (!hasBefore) return true;
        const createdMs = Date.parse(turn.createdAt);
        return Number.isFinite(createdMs) && createdMs < beforeMs;
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, input.limit);
    return rows.map((turn, idx) => ({
      id: `legacy-${idx}-${crypto
        .createHash('sha1')
        .update(`${turn.createdAt}|${turn.role}|${turn.content}`)
        .digest('hex')
        .slice(0, 20)}`,
      caregiverId: input.caregiverId,
      threadId: 'legacy-assistant-history',
      appointmentId: normalizeOptionalUuid(turn.appointmentId),
      actorType: turn.role === 'CAREGIVER' ? 'CAREGIVER' : 'ASSISTANT',
      content: String(turn.content || ''),
      source: 'LEGACY_ASSISTANT_HISTORY',
      metadata: {
        legacy: true,
        createdAt: turn.createdAt,
      },
      createdAt: String(turn.createdAt || ''),
    }));
  }

  async function loadDelegationCompilerHistory(caregiverId: string, fallback: AssistantTurn[]): Promise<DelegationContextHistoryLine[]> {
    if (shouldUseAgentDeskPersistence()) {
      const rows = await listAgentDeskMessages({
        caregiverId,
        limit: 120,
      });
      const mapped = rows
        .slice()
        .reverse()
        .map((row) => ({
          role: row.actorType === 'CAREGIVER' ? 'CAREGIVER' : 'ASSISTANT',
          content: String(row.content || ''),
          createdAt: row.createdAt,
        }))
        .filter((row) => row.content.trim().length > 0);
      if (mapped.length > 0) {
        return mapped.slice(-120);
      }
    }
    return toDelegationContextHistoryLines(fallback);
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
              appointmentId: (row as any)?.appointmentId ? String((row as any).appointmentId) : undefined,
            };
          })
          .filter((row) => row.content.length > 0)
      : [];
    const pendingRaw = raw.pending as Partial<AssistantPendingState> | undefined;
    const validPendingKinds = new Set([
      'MAPS_HOME_ADDRESS',
      'CLIENT_INFO_CONTEXT',
      'DELEGATION_CONTEXT',
      'DELEGATION_TARGET_CONTEXT',
      'DELEGATION_CONTACT_CONFIRM',
    ]);
    const validPendingTools = new Set(['MAPS_ROUTE', 'CLIENT_INFO', 'START_DELEGATION']);
    const normalizePendingClarifications = (raw: unknown): string[] => {
      if (!Array.isArray(raw)) return [];
      return raw
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0)
        .slice(-PENDING_CLARIFICATION_MAX_ITEMS);
    };
    const pending =
      pendingRaw &&
      validPendingKinds.has(String(pendingRaw.kind || '')) &&
      validPendingTools.has(String(pendingRaw.tool || '')) &&
      String(pendingRaw.baseCommand || '').trim()
        ? {
            kind: String(pendingRaw.kind) as AssistantPendingState['kind'],
            tool: String(pendingRaw.tool) as AssistantPendingState['tool'],
            baseCommand: String(pendingRaw.baseCommand || '').trim(),
            clarifications: normalizePendingClarifications((pendingRaw as any).clarifications),
            requestedAppointmentId: pendingRaw.requestedAppointmentId ? String(pendingRaw.requestedAppointmentId) : undefined,
            createdAt: String(pendingRaw.createdAt || new Date().toISOString()),
          }
        : undefined;

    const memoryRaw = (raw.memory || {}) as Partial<AssistantMemoryState>;
    const memory: AssistantMemoryState = {
      clientId: memoryRaw.clientId ? String(memoryRaw.clientId) : undefined,
      clientName: memoryRaw.clientName ? String(memoryRaw.clientName) : undefined,
      lastReferencedClientId: memoryRaw.lastReferencedClientId ? String(memoryRaw.lastReferencedClientId) : undefined,
      lastReferencedClientName: memoryRaw.lastReferencedClientName ? String(memoryRaw.lastReferencedClientName) : undefined,
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
    options?: { appointmentId?: string },
  ): AgentAssistantState {
    const trimmed = String(content || '').trim();
    if (!trimmed) return state;
    const nextHistory = [
      ...(state.history || []),
      {
        role,
        content: trimmed,
        createdAt: new Date().toISOString(),
        appointmentId: options?.appointmentId || state.memory?.appointmentId,
      },
    ];
    return { ...state, history: nextHistory.slice(-40) };
  }

  function setAssistantPending(
    state: AgentAssistantState,
    pending: Omit<AssistantPendingState, 'createdAt'>,
  ): AgentAssistantState {
    const normalizedClarifications = Array.isArray(pending.clarifications)
      ? pending.clarifications
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0)
          .slice(-PENDING_CLARIFICATION_MAX_ITEMS)
      : state.pending && state.pending.baseCommand === pending.baseCommand
        ? (state.pending.clarifications || []).slice(-PENDING_CLARIFICATION_MAX_ITEMS)
        : [];
    return {
      ...state,
      pending: {
        ...pending,
        clarifications: normalizedClarifications,
        createdAt: new Date().toISOString(),
      },
    };
  }

  function pushPendingClarification(state: AgentAssistantState, clarification: string): AgentAssistantState {
    if (!state.pending) return state;
    const trimmed = String(clarification || '').trim();
    if (!trimmed) return state;
    const current = (state.pending.clarifications || [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
    if (current[current.length - 1] === trimmed) {
      return state;
    }
    return {
      ...state,
      pending: {
        ...state.pending,
        clarifications: [...current, trimmed].slice(-PENDING_CLARIFICATION_MAX_ITEMS),
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
        lastReferencedClientId: appointment.clientId,
        lastReferencedClientName: appointment.clientName,
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
        lastReferencedClientId: resolved.clientId,
        lastReferencedClientName: resolved.clientName,
        appointmentId: resolved.appointmentId,
        businessDateHint: businessDateHint || state.memory?.businessDateHint,
      },
    };
  }

  function targetAppointmentFromResolved(
    resolved: { appointmentId: string; clientId: string; clientName: string; appointmentStartTime?: string } | null,
    appointments: CaregiverAppointmentRow[],
  ): CaregiverAppointmentRow | null {
    if (!resolved) return null;
    const byId = appointments.find((row) => row.appointmentId === resolved.appointmentId);
    if (byId) return byId;
    return (
      appointments.find(
        (row) =>
          row.clientId === resolved.clientId &&
          row.clientName === resolved.clientName &&
          row.startTime === String(resolved.appointmentStartTime || ''),
      ) || null
    );
  }

  function combineCommandWithPending(
    state: AgentAssistantState,
    command: string,
    mergeWithPending: boolean,
  ): string {
    if (!state.pending || !mergeWithPending) return command;
    const priorClarifications = (state.pending.clarifications || [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
    const sections = [state.pending.baseCommand];
    if (priorClarifications.length > 0) {
      sections.push(
        `Prior caregiver clarifications:\n${priorClarifications
          .map((value, index) => `${index + 1}. ${value}`)
          .join('\n')}`,
      );
    }
    sections.push(
      `Latest caregiver clarification (if any detail conflicts with earlier text, prioritize this clarification): ${command}`,
    );
    return sections.join('\n\n');
  }

  async function analyzeCaregiverTurnWithLLM(input: {
    command: string;
    assistantState: AgentAssistantState;
  }): Promise<CaregiverTurnSignals> {
    const deterministic = detectDeterministicTurnSignals({
      command: input.command,
      hasPending: Boolean(input.assistantState.pending),
    });
    if (deterministic.confident) {
      return deterministic.signals;
    }

    const defaults: CaregiverTurnSignals = {
      isGreeting: false,
      isAcknowledgement: false,
      isCancellation: false,
      mergeWithPending: false,
      executePending: false,
    };
    if (!config.openai.apiKey) return defaults;

    try {
      const pendingSummary = input.assistantState.pending
        ? `Pending task: kind=${input.assistantState.pending.kind}, tool=${input.assistantState.pending.tool}, baseCommand="${input.assistantState.pending.baseCommand}", createdAt=${input.assistantState.pending.createdAt}`
        : 'Pending task: none';

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
              content: `Return JSON only.

Classify the caregiver's latest message for conversation control.
- isGreeting: true only when message is primarily a greeting/opening.
- isAcknowledgement: true only when message is mainly acknowledgement/thanks with no new request.
- isCancellation: true only when message clearly cancels the current in-progress request.
- mergeWithPending: true only when a pending task exists and this message should continue that same task.
- executePending: true only when a pending task exists and the caregiver's latest message should trigger execution now (for example confirming or supplying the needed detail).

Use semantics and context, not keyword lists.
Return:
{
  "isGreeting": true|false,
  "isAcknowledgement": true|false,
  "isCancellation": true|false,
  "mergeWithPending": true|false,
  "executePending": true|false
}`,
            },
            {
              role: 'user',
              content: [
                pendingSummary,
                `Recent assistant history:\n${compactAssistantHistory(input.assistantState.history, 8)}`,
                `Latest caregiver message: ${input.command}`,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) return defaults;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<CaregiverTurnSignals>;
      return {
        isGreeting: Boolean(parsed?.isGreeting),
        isAcknowledgement: Boolean(parsed?.isAcknowledgement),
        isCancellation: Boolean(parsed?.isCancellation),
        mergeWithPending: Boolean(parsed?.mergeWithPending) && Boolean(input.assistantState.pending),
        executePending: Boolean(parsed?.executePending) && Boolean(input.assistantState.pending),
      };
    } catch {
      return defaults;
    }
  }

  function buildPendingToolDecision(
    state: AgentAssistantState,
    mergedCommand: string,
  ): AssistantPlannerDecision | null {
    if (!state.pending) return null;
    return {
      action: 'USE_TOOL',
      tool: state.pending.tool,
      infoQuestion: state.pending.tool === 'CLIENT_INFO' ? mergedCommand : undefined,
      objective: state.pending.tool === 'START_DELEGATION' ? mergedCommand : undefined,
    };
  }

  function normalizeForComparison(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isRepeatedAssistantPrompt(history: AssistantTurn[], candidate: string): boolean {
    const normalizedCandidate = normalizeForComparison(candidate);
    if (!normalizedCandidate) return false;
    const recentAssistantTurns = history.filter((turn) => turn.role === 'ASSISTANT').slice(-3);
    const repeats = recentAssistantTurns.filter(
      (turn) => normalizeForComparison(turn.content) === normalizedCandidate,
    ).length;
    return repeats >= 1;
  }

  function getActiveDelegationAppointmentIds(settings: AgentPersonaSettings): Set<string> {
    const active = new Set<string>();
    const now = Date.now();
    const delegations = settings.delegations || {};
    for (const [appointmentId, entry] of Object.entries(delegations)) {
      if (!entry || !entry.active) continue;
      const endsAtMs = Date.parse(String(entry.endsAt || ''));
      if (Number.isFinite(endsAtMs) && endsAtMs > now) {
        active.add(appointmentId);
      }
    }
    return active;
  }

  function hasRelevantActiveDelegation(input: {
    settings: AgentPersonaSettings;
    appointmentId?: string;
  }): boolean {
    const activeAppointmentIds = getActiveDelegationAppointmentIds(input.settings);
    if (activeAppointmentIds.size === 0) return false;
    const appointmentId = normalizeOptionalUuid(input.appointmentId);
    if (appointmentId) return activeAppointmentIds.has(appointmentId);
    return true;
  }

  function enforceDelegationStateClaims(input: {
    response: string;
    hasRelevantActiveDelegation: boolean;
  }): string {
    const trimmed = String(input.response || '').trim();
    if (!trimmed || input.hasRelevantActiveDelegation) return trimmed;

    const sentenceHasInvalidDelegationClaim = (sentence: string): boolean => {
      const normalized = normalizeCommandText(sentence);
      if (!normalized) return false;
      return (
        /\b(already|currently|still)\b.*\b(started|initiated|have)\b.*\bdelegation\b/.test(normalized) ||
        /\bactive delegation\b/.test(normalized) ||
        /\bwait(?:ing)? for (a|the) response\b/.test(normalized) ||
        /\bdelegation (is|has been) (active|started|initiated)\b/.test(normalized)
      );
    };

    const sentences = trimmed.match(/[^.!?]+[.!?]?/g) || [trimmed];
    const filtered = sentences.filter((sentence) => !sentenceHasInvalidDelegationClaim(sentence));
    if (filtered.length === 0) {
      return 'I have not started delegation for that yet. I can contact the client/family if you want.';
    }
    return filtered.join(' ').trim();
  }

  function enforceNonToolResponseSafety(input: {
    response: string;
    command: string;
    hasRelevantActiveDelegation: boolean;
  }): string {
    const trimmed = enforceDelegationStateClaims({
      response: input.response,
      hasRelevantActiveDelegation: input.hasRelevantActiveDelegation,
    });
    if (!trimmed) return trimmed;

    const claimsExecution =
      /\b(i|we)\s+(?:have|ve|had|just)?\s*(?:initiated|started|sent|reached out|contacted|messaged|asked)\b/i.test(trimmed) ||
      /\brequest (?:has been|was) sent\b/i.test(trimmed);
    if (claimsExecution) {
      if (hasDelegationIntent(input.command)) {
        return 'I have not contacted them yet in this turn. I can start delegation now to ask those questions.';
      }
      return trimmed.replace(
        /\b(i|we)\s+(?:have|ve|had|just)?\s*(?:initiated|started|sent|reached out|contacted|messaged|asked)\b[^.]*[.]?/gi,
        '',
      ).trim() || 'I have not executed that action yet in this turn.';
    }

    return trimmed;
  }

  function indicatesUnknownOrIncompleteInfo(text: string): boolean {
    const normalized = normalizeCommandText(text);
    if (!normalized) return false;
    return (
      /\b(i do not have|i don't have|i currently do not have|i currently don't have)\b/.test(normalized) ||
      /\b(i cannot confirm|i can't confirm|i cannot verify|i can't verify)\b/.test(normalized) ||
      /\b(could not find enough detail|couldn't find enough detail|insufficient evidence|not enough detail)\b/.test(normalized) ||
      /\b(no messages yet|no information yet)\b/.test(normalized) ||
      /\b(recommend reaching out|reach out directly|contact .* directly)\b/.test(normalized)
    );
  }

  function commandRequestsFindOut(command: string): boolean {
    const normalized = normalizeCommandText(command);
    if (!normalized) return false;
    return (
      /\bfind out\b/.test(normalized) ||
      /\bif you do not know\b/.test(normalized) ||
      /\bif you don't know\b/.test(normalized) ||
      /\bcan you verify\b/.test(normalized) ||
      /\bcan you confirm\b/.test(normalized) ||
      /\bcheck for me\b/.test(normalized)
    );
  }

  function looksLikeClientFactQuestion(command: string): boolean {
    const normalized = normalizeCommandText(command);
    if (!normalized) return false;
    const scheduleLike = /\b(schedule|appointments|visits?|shift|day|tomorrow|today|yesterday)\b/.test(normalized);
    const mapsLike = /\b(route|routes|map|maps|drive|driving|traffic|travel|eta)\b/.test(normalized);
    if (scheduleLike || mapsLike) return false;
    const personRef =
      /\b(client|family|parent|guardian|patient|him|her|them)\b/.test(normalized) ||
      /\b[a-z][a-z'-]{1,}'s\b/.test(normalized);
    const factCue =
      /\b(fridge|refrigerator|food|banana|bananas|house|home|advil|ibuprofen|med|medicine|supplies|dog|pet|access|code|likes?|prefer|favorite|allerg|scared|afraid|enjoy|sport|sports)\b/.test(normalized) ||
      /\b(what does .* like|what does .* enjoy)\b/.test(normalized);
    return factCue && (personRef || /\b(does|did|is|has|have)\b/.test(normalized));
  }

  function hasClientReferenceCue(input: {
    command: string;
    assistantState: AgentAssistantState;
    requestedAppointmentId?: string;
    appointments: CaregiverAppointmentRow[];
  }): boolean {
    const normalized = normalizeCommandText(input.command);
    if (!normalized) return false;
    if (String(input.requestedAppointmentId || '').trim()) return true;
    if (Boolean(input.assistantState.memory?.appointmentId)) return true;
    if (Boolean(input.assistantState.memory?.clientName || input.assistantState.memory?.lastReferencedClientName)) return true;
    if (Boolean(extractClientHint(input.command))) return true;
    if (Boolean(extractClientHintFromKnownAppointments(input.command, input.appointments))) return true;
    return /\b(he|she|him|her|his|hers|they|them|their|the client|the patient)\b/.test(normalized);
  }

  function shouldForceClientInfoFromContext(input: {
    command: string;
    assistantState: AgentAssistantState;
    appointments: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
  }): boolean {
    if (!looksLikeClientFactQuestion(input.command)) return false;
    if (!hasClientReferenceCue(input)) return false;
    if (hasExplicitDelegationDirective(input.command)) return false;
    return true;
  }

  function buildDelegationContactConfirmationPrompt(knownInfoPrefix?: string): string {
    const prefix = String(knownInfoPrefix || '').trim();
    const confirmation =
      'I can contact the client/family to find out the missing details. Do you want me to reach out now? Reply yes to proceed or cancel to stop.';
    return prefix ? `${prefix}\n\n${confirmation}` : confirmation;
  }

  async function evaluateMissingInfoPolicy(input: {
    command: string;
    answerDraft: string;
    source: 'RESPOND' | 'CLIENT_INFO';
  }): Promise<MissingInfoPolicyDecision> {
    const deterministicAcquire =
      hasExplicitDelegationDirective(input.command) ||
      (hasDelegationIntent(input.command) && commandRequestsFindOut(input.command)) ||
      (looksLikeClientFactQuestion(input.command) && indicatesUnknownOrIncompleteInfo(input.answerDraft));
    if (!config.openai.apiKey) {
      return deterministicAcquire
        ? { action: 'ACQUIRE_MISSING_INFO', confidence: 0.9, rationale: 'deterministic_missing_info_policy' }
        : { action: 'ANSWER_FROM_KNOWN_INFO', confidence: 0.9, rationale: 'deterministic_known_info_policy' };
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
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Return JSON only.

Decide whether the assistant should only answer from known information or should acquire missing information by contacting client/family (delegation).

Use these actions only:
- ANSWER_FROM_KNOWN_INFO
- ACQUIRE_MISSING_INFO

Rules:
- Choose ACQUIRE_MISSING_INFO when caregiver asks for client/family facts that are still unknown/incomplete and asks to find out/verify/contact.
- Choose ANSWER_FROM_KNOWN_INFO when answer is complete enough or request is not asking for client/family fact acquisition.
- If unsure, prefer ACQUIRE_MISSING_INFO only when command clearly requests finding out missing facts.

Return:
{
  "action": "ANSWER_FROM_KNOWN_INFO|ACQUIRE_MISSING_INFO",
  "confidence": 0-1,
  "rationale": "short string"
}`,
            },
            {
              role: 'user',
              content: [
                `Source path: ${input.source}`,
                `Caregiver command: ${input.command}`,
                `Draft answer: ${input.answerDraft}`,
                `Deterministic hint: ${deterministicAcquire ? 'ACQUIRE_MISSING_INFO' : 'ANSWER_FROM_KNOWN_INFO'}`,
              ].join('\n\n'),
            },
          ],
        }),
      });
      if (!response.ok) {
        return deterministicAcquire
          ? { action: 'ACQUIRE_MISSING_INFO', confidence: 0.8, rationale: 'fallback_after_policy_http_error' }
          : { action: 'ANSWER_FROM_KNOWN_INFO', confidence: 0.8, rationale: 'fallback_after_policy_http_error' };
      }
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      const parsed = tryParseJsonObject(raw) || {};
      const actionRaw = String(parsed?.action || '').trim().toUpperCase();
      const confidenceRaw = Number(parsed?.confidence);
      const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;
      const rationale = String(parsed?.rationale || '').trim() || 'llm_policy';
      if (actionRaw === 'ACQUIRE_MISSING_INFO') {
        return { action: 'ACQUIRE_MISSING_INFO', confidence, rationale };
      }
      if (actionRaw === 'ANSWER_FROM_KNOWN_INFO') {
        return { action: 'ANSWER_FROM_KNOWN_INFO', confidence, rationale };
      }
      return deterministicAcquire
        ? { action: 'ACQUIRE_MISSING_INFO', confidence: 0.75, rationale: 'deterministic_fallback_after_invalid_policy_json' }
        : { action: 'ANSWER_FROM_KNOWN_INFO', confidence: 0.75, rationale: 'deterministic_fallback_after_invalid_policy_json' };
    } catch {
      return deterministicAcquire
        ? { action: 'ACQUIRE_MISSING_INFO', confidence: 0.75, rationale: 'deterministic_fallback_after_policy_exception' }
        : { action: 'ANSWER_FROM_KNOWN_INFO', confidence: 0.75, rationale: 'deterministic_fallback_after_policy_exception' };
    }
  }

  async function sanitizeNonToolAssistantResponse(input: {
    response: string;
    command: string;
    assistantState: AgentAssistantState;
    appointments: CaregiverAppointmentRow[];
    settings: AgentPersonaSettings;
    appointmentIdHint?: string;
  }): Promise<string> {
    const trimmed = String(input.response || '').trim();
    if (!trimmed) return trimmed;
    const hasActiveDelegationForContext = hasRelevantActiveDelegation({
      settings: input.settings,
      appointmentId: input.appointmentIdHint || input.assistantState.memory?.appointmentId,
    });
    if (!config.openai.apiKey) {
      return enforceNonToolResponseSafety({
        response: trimmed,
        command: input.command,
        hasRelevantActiveDelegation: hasActiveDelegationForContext,
      });
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
              content: `Return JSON only.

This assistant response is for a turn where no backend tool was executed.
Decide whether the draft response incorrectly claims or implies that an external/system action was already executed in this turn.
If it does, rewrite it so it stays helpful but clearly avoids claiming execution.
If it does not, return the response unchanged.

Return:
{
  "safeResponse": "string",
  "claimsExecution": true|false
}`,
            },
            {
              role: 'user',
              content: [
                `Latest caregiver message: ${input.command}`,
                `Recent assistant history:\n${compactAssistantHistory(input.assistantState.history, 8)}`,
                `Appointment snapshot:\n${summarizeAppointmentsForPlanner(input.appointments, 6)}`,
                `Draft response:\n${trimmed}`,
              ].join('\n\n'),
            },
          ],
        }),
      });
      if (!res.ok) {
        return enforceNonToolResponseSafety({
          response: trimmed,
          command: input.command,
          hasRelevantActiveDelegation: hasActiveDelegationForContext,
        });
      }
      const payload = (await res.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) {
        return enforceNonToolResponseSafety({
          response: trimmed,
          command: input.command,
          hasRelevantActiveDelegation: hasActiveDelegationForContext,
        });
      }
      const parsed = JSON.parse(raw) as { safeResponse?: unknown };
      const safeResponse = String(parsed?.safeResponse || '').trim();
      return enforceNonToolResponseSafety({
        response: safeResponse || trimmed,
        command: input.command,
        hasRelevantActiveDelegation: hasActiveDelegationForContext,
      });
    } catch {
      return enforceNonToolResponseSafety({
        response: trimmed,
        command: input.command,
        hasRelevantActiveDelegation: hasActiveDelegationForContext,
      });
    }
  }

  function inferToolForFollowUp(
    plannerDecision: AssistantPlannerDecision,
    assistantState: AgentAssistantState,
    commandForPlanning: string,
  ): AssistantPlannerTool | undefined {
    void commandForPlanning;
    if (plannerDecision.tool) return plannerDecision.tool;
    if (assistantState.pending?.tool) {
      return assistantState.pending.tool as AssistantPlannerTool;
    }
    return undefined;
  }

  function buildFollowUpQuestionFromRequiredSlots(
    requiredSlots: AssistantRequiredSlot[] | undefined,
    fallbackTool?: AssistantPlannerTool,
  ): string | null {
    const slots = Array.isArray(requiredSlots) ? requiredSlots : [];
    if (slots.includes('HOME_ADDRESS')) {
      return 'What is your home address so I can calculate that route?';
    }
    if (slots.includes('APPOINTMENT_TARGET')) {
      return 'Which client or visit should I use?';
    }
    if (slots.includes('CLIENT_INFO_QUESTION')) {
      return 'What specific client detail should I look up?';
    }
    if (slots.includes('DELEGATION_OBJECTIVE')) {
      return 'What exactly should I ask the client or family to confirm?';
    }
    if (fallbackTool === 'MAPS_ROUTE') return 'What is your home address so I can calculate that route?';
    if (fallbackTool === 'CLIENT_INFO') return 'Which client or visit should I use for that lookup?';
    if (fallbackTool === 'START_DELEGATION') return 'Which visit should I delegate, and what should I ask?';
    return null;
  }

  function maybeDeterministicFallbackPlannerDecision(input: {
    command: string;
    turnSignals: CaregiverTurnSignals;
    assistantState: AgentAssistantState;
    appointments?: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
  }): AssistantPlannerDecision | null {
    const normalized = normalizeCommandText(input.command);
    if (!normalized) return null;

    if (input.assistantState.pending && (input.turnSignals.executePending || input.turnSignals.mergeWithPending)) {
      return buildPendingToolDecision(input.assistantState, combineCommandWithPending(input.assistantState, input.command, true));
    }

    const scheduleIntent = /\b(schedule|appointments|visits?|day|shift|gaps?)\b/.test(normalized);
    const mapsIntent = /\b(route|routes|map|maps|drive|driving|traffic|travel|eta)\b/.test(normalized);
    const clientInfoIntent =
      /\b(access code|history|what did|what has|said about|notes|client info|family said|care plan update|meds update)\b/.test(
        normalized,
      ) ||
      /\b(access)\b/.test(normalized) ||
      (Array.isArray(input.appointments)
        ? shouldForceClientInfoFromContext({
            command: input.command,
            assistantState: input.assistantState,
            appointments: input.appointments,
            requestedAppointmentId: input.requestedAppointmentId,
          })
        : false);
    const delegationIntent = hasDelegationIntent(input.command);

    if (mapsIntent) {
      return {
        action: 'USE_TOOL',
        tool: 'MAPS_ROUTE',
      };
    }

    if (delegationIntent) {
      return {
        action: 'USE_TOOL',
        tool: 'START_DELEGATION',
        objective: input.command.trim(),
      };
    }

    if (clientInfoIntent && !scheduleIntent) {
      return {
        action: 'USE_TOOL',
        tool: 'CLIENT_INFO',
        infoQuestion: input.command.trim(),
      };
    }

    if (scheduleIntent) {
      return {
        action: 'USE_TOOL',
        tool: 'SCHEDULE_DAY',
      };
    }

    return null;
  }

  function parseBusinessDateHint(command: string): string | null {
    return parseBusinessDateHintPolicy(command, getCurrentBusinessDateIso());
  }

  function resolveRequestedBusinessDate(command: string, memoryBusinessDateHint?: string): string {
    return resolveRequestedBusinessDatePolicy(command, memoryBusinessDateHint, getCurrentBusinessDateIso());
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

  function tryParseJsonObject(raw: string): any | null {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = text.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
      return null;
    }
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
    const normalizedTool: AssistantPlannerTool | undefined = (
      ['SCHEDULE_DAY', 'MAPS_ROUTE', 'CLIENT_INFO', 'START_DELEGATION'] as const
    ).includes(
      tool as AssistantPlannerTool,
    )
      ? (tool as AssistantPlannerTool)
      : undefined;

    const questions = Array.isArray(raw.questions)
      ? raw.questions.map((q: unknown) => String(q || '').trim()).filter(Boolean).slice(0, 6)
      : undefined;
    const requiredSlotsRaw = Array.isArray(raw.requiredSlots)
      ? raw.requiredSlots
      : Array.isArray(raw.required_slots)
      ? raw.required_slots
      : [];
    const responseStyleRaw = raw.responseStyle ?? raw.response_style;

    return {
      action: action as AssistantPlannerDecision['action'],
      response: raw.response ? String(raw.response).trim() : undefined,
      followUpQuestion: (raw.followUpQuestion || raw.follow_up_question)
        ? String(raw.followUpQuestion || raw.follow_up_question).trim()
        : undefined,
      tool: normalizedTool,
      homeAddress: (raw.homeAddress || raw.home_address) ? String(raw.homeAddress || raw.home_address).trim() : undefined,
      appointmentHint: (raw.appointmentHint || raw.appointment_hint)
        ? String(raw.appointmentHint || raw.appointment_hint).trim()
        : undefined,
      objective: raw.objective ? String(raw.objective).trim() : undefined,
      questions,
      infoQuestion: (raw.infoQuestion || raw.info_question) ? String(raw.infoQuestion || raw.info_question).trim() : undefined,
      requiredSlots: normalizeRequiredSlots(requiredSlotsRaw),
      responseStyle: normalizeResponseStyle(responseStyleRaw),
    };
  }

  async function repairPlannerDecisionWithLLM(input: {
    rawContent: string;
    allowFollowUp: boolean;
  }): Promise<AssistantPlannerDecision | null> {
    if (!config.openai.apiKey) return null;

    try {
      const allowedActions = input.allowFollowUp
        ? 'RESPOND, ASK_FOLLOW_UP, USE_TOOL'
        : 'RESPOND, USE_TOOL';
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
              content: `Return JSON only.

You normalize a malformed assistant-planner output into the required schema.
Allowed action values: ${allowedActions}.
Allowed tool values: SCHEDULE_DAY, MAPS_ROUTE, CLIENT_INFO, START_DELEGATION.
If the malformed output is ambiguous, choose the safest valid action with minimal speculation.

Return this schema exactly:
{
  "action": "RESPOND|ASK_FOLLOW_UP|USE_TOOL",
  "response": "string optional",
  "followUpQuestion": "string optional",
  "tool": "SCHEDULE_DAY|MAPS_ROUTE|CLIENT_INFO|START_DELEGATION optional",
  "homeAddress": "string optional",
  "appointmentHint": "string optional",
  "objective": "string optional",
  "questions": ["string"] optional,
  "infoQuestion": "string optional",
  "required_slots": ["APPOINTMENT_TARGET|HOME_ADDRESS|CLIENT_INFO_QUESTION|DELEGATION_OBJECTIVE"] optional,
  "response_style": "CONCISE|STEP_BY_STEP optional"
}`,
            },
            {
              role: 'user',
              content: `Malformed planner output:\n${input.rawContent}`,
            },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const normalizedRaw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!normalizedRaw) return null;
      const parsed = tryParseJsonObject(normalizedRaw);
      if (!parsed) return null;
      const normalized = normalizeAssistantPlannerDecision(parsed);
      if (!normalized) return null;
      if (!input.allowFollowUp && normalized.action === 'ASK_FOLLOW_UP') {
        if (normalized.tool) {
          return {
            ...normalized,
            action: 'USE_TOOL',
          };
        }
        return { action: 'RESPOND' };
      }
      return normalized;
    } catch {
      return null;
    }
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

Decision policy:
- Use RESPOND for conversational/general requests or when no system data/tool is needed.
- Use USE_TOOL when an accurate answer depends on schedule data, map estimates, chat history retrieval, or delegation actions.
- First decide whether caregiver needs known-info answer vs missing-info acquisition. For missing client/family facts, prefer START_DELEGATION over a dead-end RESPOND.
- Use ASK_FOLLOW_UP only when a required input is missing; ask exactly one concise question.
- When action is ASK_FOLLOW_UP, list missing structured slots in "required_slots".
- Prefer proceeding with best available defaults over additional clarification whenever safe.
- Reuse pending context and memory to continue in-progress tasks rather than resetting topics.
- For requests outside available tools (for example external real-time data not connected here), respond directly with limits instead of follow-up loops.
- If the caregiver asks you to contact a client/family (including a named person, e.g. "ask Yashwanth if..."), choose START_DELEGATION.
- Treat "if you don't know, can you find out for me" (or equivalent) as START_DELEGATION when the request is about client/family facts.
- Never return RESPOND for explicit caregiver outreach directives ("can you ask/reach out/contact ..."); use START_DELEGATION.
- If a pending task exists and the caregiver confirms/proceeds or supplies requested detail, choose USE_TOOL for that pending task.
- Avoid confirmation loops. If target appointment can be inferred from context/history, choose USE_TOOL instead of ASK_FOLLOW_UP.
- If action is ASK_FOLLOW_UP, include the intended tool in "tool".
- Keep outputs concise and operational.
- Set "response_style" to CONCISE by default. Use STEP_BY_STEP only when caregiver asks for a walkthrough.

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
  "infoQuestion": "string optional for CLIENT_INFO",
  "required_slots": ["APPOINTMENT_TARGET|HOME_ADDRESS|CLIENT_INFO_QUESTION|DELEGATION_OBJECTIVE"] optional,
  "response_style": "CONCISE|STEP_BY_STEP optional"
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
    const parsed = tryParseJsonObject(rawContent);
    let decision = normalizeAssistantPlannerDecision(parsed);
    if (!decision && shouldUsePlannerRepairHop(config.assistant)) {
      decision = await repairPlannerDecisionWithLLM({
        rawContent,
        allowFollowUp: true,
      });
    }
    if (!decision) {
      throw new Error('Assistant planner returned invalid decision payload.');
    }
    decision = applyRouterContractDefaults(decision);

    console.log('[AGENT] Planner decision', {
      action: decision.action,
      tool: decision.tool || null,
      requiredSlots: decision.requiredSlots || [],
      responseStyle: decision.responseStyle || 'CONCISE',
      latencyMs: Date.now() - startedAt,
    });
    return decision;
  }

  async function recoverToolDecisionWithLLM(input: {
    command: string;
    assistantState: AgentAssistantState;
    appointments: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
  }): Promise<AssistantPlannerDecision | null> {
    if (!config.openai.apiKey) {
      return null;
    }

    try {
      const pendingSummary = input.assistantState.pending
        ? `Pending: kind=${input.assistantState.pending.kind}, tool=${input.assistantState.pending.tool}, baseCommand="${input.assistantState.pending.baseCommand}"`
        : 'Pending: none';

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
              content: `Return JSON only.

You are a strict operation router for caregiver assistant messages.
Choose one action:
- RESPOND: conversational answer only.
- USE_TOOL: execute exactly one tool.

Available tools:
- SCHEDULE_DAY
- MAPS_ROUTE
- CLIENT_INFO
- START_DELEGATION

Policy:
- Choose USE_TOOL when the caregiver is asking for an operation or data retrieval supported by tools.
- If caregiver wants the assistant to contact/reach out/ask a client or family member (including a named person), choose START_DELEGATION.
- Treat "find out for me" about a client/family person as START_DELEGATION.
- Never answer with "I cannot directly ask/contact" when outreach is requested; choose START_DELEGATION instead.
- If pending context exists and the caregiver gives a short follow-up or confirmation, continue with that pending tool.
- Treat brief confirmations/approvals as execute-intent when they follow a recent assistant proposal for a tool action.
- Avoid asking another follow-up if a tool can run with currently available context.
- Choose RESPOND for general conversation or requests outside available tools.
- Never return ASK_FOLLOW_UP in this classifier.

Output schema:
{
  "action": "RESPOND|USE_TOOL",
  "tool": "SCHEDULE_DAY|MAPS_ROUTE|CLIENT_INFO|START_DELEGATION optional",
  "appointmentHint": "string optional",
  "objective": "string optional",
  "questions": ["string"] optional,
  "infoQuestion": "string optional",
  "required_slots": ["APPOINTMENT_TARGET|HOME_ADDRESS|CLIENT_INFO_QUESTION|DELEGATION_OBJECTIVE"] optional,
  "response_style": "CONCISE|STEP_BY_STEP optional"
}`,
            },
            {
              role: 'user',
              content: [
                `Requested appointmentId: ${input.requestedAppointmentId || 'none'}`,
                pendingSummary,
                `Recent assistant history:\n${compactAssistantHistory(input.assistantState.history, 10)}`,
                `Appointment snapshot:\n${summarizeAppointmentsForPlanner(input.appointments, 8)}`,
                `Latest caregiver message: ${input.command}`,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return null;
      const parsed = tryParseJsonObject(raw);
      let decision = normalizeAssistantPlannerDecision(parsed);
      if (!decision) {
        decision = await repairPlannerDecisionWithLLM({
          rawContent: raw,
          allowFollowUp: false,
        });
      }
      if (!decision) return null;
      if (decision.action !== 'USE_TOOL') return applyRouterContractDefaults({ action: 'RESPOND' });
      if (!decision.tool) return null;
      return applyRouterContractDefaults(decision);
    } catch {
      return null;
    }
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
                'You are a caregiver personal assistant in conversational fallback mode. Respond naturally, directly, and helpfully while staying grounded in caregiver workflow context. Give direct answers for non-tool questions. If data or actions require tools/system calls, state that limitation clearly and suggest the next concrete step. Do not invent real-time data access. In this mode, do not claim that you already executed actions (for example sending messages, starting delegation, fetching maps, or querying records). Do not mention internal execution steps or ask the caregiver what command to run.',
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

  async function extractKeyPointsWithLLM(
    messages: Array<{ sender_type: string; content: string }>,
  ): Promise<string[]> {
    const normalized = messages
      .map((m) => ({
        senderType: String(m.sender_type || '').trim(),
        content: String(m.content || '').trim(),
      }))
      .filter((m) => m.content.length > 0)
      .slice(-20);
    if (normalized.length === 0) return [];
    if (!config.openai.apiKey) {
      return normalized.slice(-5).map((m) => `[${m.senderType}] ${compactSnippet(m.content, 180)}`);
    }

    try {
      const transcript = normalized
        .map((m, idx) => `${idx + 1}. [${m.senderType}] ${compactSnippet(m.content, 200)}`)
        .join('\n');
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
              content: `Return JSON only.

Extract up to 8 concise logistics-relevant key points from the conversation.
Each key point should preserve concrete facts and speaker context.
Avoid generic restatements.
Ignore pure acknowledgements ("ok", "thanks") and avoid duplicate phrasing.
Prefer concrete updates that change caregiver decisions (access, timing, meds/supplies, safety, care-plan changes).

Return:
{
  "points": ["string"]
}`,
            },
            {
              role: 'user',
              content: `Conversation lines:\n${transcript}`,
            },
          ],
        }),
      });
      if (!response.ok) return normalized.slice(-5).map((m) => `[${m.senderType}] ${compactSnippet(m.content, 180)}`);
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return normalized.slice(-5).map((m) => `[${m.senderType}] ${compactSnippet(m.content, 180)}`);
      const parsed = JSON.parse(raw) as { points?: unknown };
      const points = Array.isArray(parsed?.points)
        ? parsed.points.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 8)
        : [];
      return points.length > 0
        ? points
        : normalized.slice(-5).map((m) => `[${m.senderType}] ${compactSnippet(m.content, 180)}`);
    } catch {
      return normalized.slice(-5).map((m) => `[${m.senderType}] ${compactSnippet(m.content, 180)}`);
    }
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

  async function buildDelegationSummary(
    appointmentId: string,
    startedAt: string,
    endedAt: string,
    context?: { objective?: string; questions?: string[] },
  ): Promise<string> {
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

    const keyPoints = await extractKeyPointsWithLLM(messagesRes.rows.map((m) => ({
      sender_type: String(m.sender_type),
      content: String(m.content),
    })));

    return buildCaregiverDelegationSummary({
      startedAtLabel: formatBusinessDateTime(startedAt),
      endedAtLabel: formatBusinessDateTime(endedAt),
      objective: String(context?.objective || '').trim() || 'Collect logistics updates and keep client informed.',
      requestedQuestions: Array.isArray(context?.questions) ? context?.questions.map(String) : [],
      llmKeyPoints: keyPoints,
      messages: messagesRes.rows.map((row) => ({
        senderType: String(row.sender_type || ''),
        content: String(row.content || ''),
        createdAt: String(row.created_at || ''),
      })),
    });
  }

  async function pickFirstClientAskableQuestionIndexWithLLM(questions: string[]): Promise<number> {
    if (questions.length === 0) return -1;
    if (!config.openai.apiKey) return 0;

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
              content: `Return JSON only.

Select the best first question to ask a client/family participant during delegation.
Prefer questions that are directly answerable by the client and avoid questions that require internal care-team/provider-only knowledge.

Return:
{
  "index": number
}
Index is zero-based. If no question is appropriate, return -1.`,
            },
            {
              role: 'user',
              content: questions.map((q, idx) => `${idx}: ${q}`).join('\n'),
            },
          ],
        }),
      });
      if (!response.ok) return 0;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as { index?: unknown };
      const idx = Number(parsed?.index);
      if (!Number.isInteger(idx)) return 0;
      if (idx < 0 || idx >= questions.length) return -1;
      return idx;
    } catch {
      return 0;
    }
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
    const normalizeQuestionItem = (row: unknown): DelegationQuestionItem | null => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, unknown>;
      const text = String(item.text || '').trim();
      if (!text) return null;
      const priority = String(item.priority || '').trim().toUpperCase() === 'OPTIONAL' ? 'OPTIONAL' : 'PRIMARY';
      return { text, priority };
    };
    const normalizeQuestionTextKey = (value: string): string =>
      String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const normalizeQuestionIndexes = (values: unknown, questionCount: number): number[] => {
      if (!Array.isArray(values)) return [];
      return values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < questionCount)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .sort((a, b) => a - b);
    };
    const questionItemsRaw: DelegationQuestionItem[] = Array.isArray(input.questionItems)
      ? input.questionItems
          .map((row) => normalizeQuestionItem(row))
          .filter((row): row is DelegationQuestionItem => Boolean(row))
      : [];
    const fallbackQuestionItems = Array.isArray(input.questions)
      ? input.questions
          .map((q) => String(q || '').trim())
          .filter(Boolean)
          .map((text) => ({ text, priority: 'PRIMARY' as const }))
      : [];
    const questionItems =
      questionItemsRaw.length > 0
        ? questionItemsRaw
        : fallbackQuestionItems.length > 0
          ? fallbackQuestionItems
          : [{ text: 'Can you help confirm the missing details needed before the visit?', priority: 'PRIMARY' as const }];
    const questions = questionItems.map((item) => item.text);
    const primaryQuestionIndexes = questionItems
      .map((item, idx) => (item.priority === 'PRIMARY' ? idx : -1))
      .filter((idx) => idx >= 0);
    const safePrimaryQuestionIndexes =
      primaryQuestionIndexes.length > 0 ? primaryQuestionIndexes : (questions.length > 0 ? [0] : []);
    const optionalQuestionIndexes = questionItems
      .map((item, idx) => (item.priority === 'OPTIONAL' ? idx : -1))
      .filter((idx) => idx >= 0);
    const delegationTypeRaw =
      String(input.delegationType || input.contextPacket?.delegationType || '').trim().toUpperCase();
    const delegationType: DelegationType =
      delegationTypeRaw === 'FACT_CHECK' || delegationTypeRaw === 'LOGISTICS' || delegationTypeRaw === 'OPEN_ENDED'
        ? (delegationTypeRaw as DelegationType)
        : inferDelegationTypeFromCommand(`${objective} ${questions.join(' ')}`.trim());

    const apptRes = await pool.query(
      `
        SELECT id::text, client_id::text AS client_id
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
    const appointmentClientId = String(apptRes.rows[0]?.client_id || '').trim();

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
    const existingDelegation = delegations[appointmentId];

    const existingEndsAtMs = Date.parse(String(existingDelegation?.endsAt || ''));
    const hasUnexpiredExisting = Boolean(existingDelegation?.active) && Number.isFinite(existingEndsAtMs) && existingEndsAtMs > now.getTime();

    if (hasUnexpiredExisting && !isSystemManagedDelegationEntry(existingDelegation)) {
      const existingQuestionItemsRaw = Array.isArray(existingDelegation?.questionItems)
        ? existingDelegation.questionItems
        : [];
      const existingQuestionItemsFromItems = existingQuestionItemsRaw
        .map((row) => normalizeQuestionItem(row))
        .filter((row): row is DelegationQuestionItem => Boolean(row));
      const existingQuestionItemsFallback = Array.isArray(existingDelegation?.questions)
        ? existingDelegation.questions
            .map((text) => String(text || '').trim())
            .filter(Boolean)
            .map((text) => ({ text, priority: 'PRIMARY' as const }))
        : [];
      const existingQuestionItems =
        existingQuestionItemsFromItems.length > 0
          ? existingQuestionItemsFromItems
          : existingQuestionItemsFallback;
      const mergedQuestionItems: DelegationQuestionItem[] = [];
      const seenQuestionKeys = new Set<string>();
      for (const item of existingQuestionItems) {
        mergedQuestionItems.push(item);
        const key = normalizeQuestionTextKey(item.text);
        if (key) seenQuestionKeys.add(key);
      }
      const addedQuestionIndexes: number[] = [];
      for (const item of questionItems) {
        const key = normalizeQuestionTextKey(item.text);
        if (!key || seenQuestionKeys.has(key)) continue;
        seenQuestionKeys.add(key);
        addedQuestionIndexes.push(mergedQuestionItems.length);
        mergedQuestionItems.push(item);
      }

      if (addedQuestionIndexes.length === 0) {
        return {
          ok: true,
          delegation: existingDelegation as DelegationEntry,
          firstQuestion: null,
          reusedExisting: true,
          appendedQuestionCount: 0,
          newlyAskedQuestions: [],
        };
      }

      const mergedQuestions = mergedQuestionItems.map((item) => item.text);
      const mergedPrimaryQuestionIndexes = mergedQuestionItems
        .map((item, idx) => (item.priority === 'PRIMARY' ? idx : -1))
        .filter((idx) => idx >= 0);
      const safeMergedPrimaryQuestionIndexes =
        mergedPrimaryQuestionIndexes.length > 0
          ? mergedPrimaryQuestionIndexes
          : (mergedQuestions.length > 0 ? [0] : []);
      const mergedOptionalQuestionIndexes = mergedQuestionItems
        .map((item, idx) => (item.priority === 'OPTIONAL' ? idx : -1))
        .filter((idx) => idx >= 0);
      const existingQuestionCount = existingQuestionItems.length;
      const priorResolved = normalizeQuestionIndexes(existingDelegation?.resolvedQuestionIndexes, existingQuestionCount);
      const priorAsked = normalizeQuestionIndexes(existingDelegation?.askedQuestionIndexes, existingQuestionCount);
      const priorProgress = normalizeQuestionIndexes(existingDelegation?.progressNotifiedIndexes, existingQuestionCount);
      const priorAskedSet = new Set<number>(priorAsked);
      const priorResolvedSet = new Set<number>(priorResolved);
      const askableNewIndexes = addedQuestionIndexes.filter(
        (idx) => !priorAskedSet.has(idx) && !priorResolvedSet.has(idx),
      );
      const factCheckCandidates = askableNewIndexes.filter((idx) => safeMergedPrimaryQuestionIndexes.includes(idx));
      const nextAskedNow =
        (existingDelegation?.delegationType || delegationType) === 'FACT_CHECK'
          ? (factCheckCandidates.length > 0 ? factCheckCandidates : askableNewIndexes).slice(0, 2)
          : askableNewIndexes.slice(0, 1);
      const nextAskedSet = new Set<number>([...priorAsked, ...nextAskedNow]);
      const nextAsked = Array.from(nextAskedSet).sort((a, b) => a - b);

      const nextDelegation: DelegationEntry = {
        ...(existingDelegation as DelegationEntry),
        active: true,
        objective: String(existingDelegation?.objective || objective || '').trim(),
        questions: mergedQuestions,
        questionItems: mergedQuestionItems,
        primaryQuestionIndexes: safeMergedPrimaryQuestionIndexes,
        optionalQuestionIndexes: mergedOptionalQuestionIndexes,
        resolvedQuestionIndexes: priorResolved,
        askedQuestionIndexes: nextAsked,
        progressNotifiedIndexes: priorProgress,
        completionNotifiedAt: undefined,
        contextPacket: {
          ...(existingDelegation?.contextPacket || {}),
          delegationType: existingDelegation?.delegationType || delegationType,
          primaryQuestionCount: safeMergedPrimaryQuestionIndexes.length,
          optionalQuestionCount: mergedOptionalQuestionIndexes.length,
        },
      };
      delegations[appointmentId] = nextDelegation;
      settings.delegations = delegations;
      await saveAgentSettings(input.userId, role || 'CAREGIVER', settings, { activateAgent: true });

      if (nextAskedNow.length > 0) {
        const followUpMessage =
          nextAskedNow.length > 1
            ? [
                'Thanks for the update from your caregiver. I have a couple more quick questions:',
                ...nextAskedNow.map((idx, offset) => `${offset + 1}) ${mergedQuestions[idx]}`),
                'Please answer what you know.',
              ].join('\n')
            : `Thanks for the update from your caregiver. One more quick question: ${mergedQuestions[nextAskedNow[0]]}`;
        await pool.query(
          `
            INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
            VALUES ($1, 'AI_AGENT', $2, $3, true)
          `,
          [appointmentId, input.userId, followUpMessage],
        );
      }

      return {
        ok: true,
        delegation: nextDelegation,
        firstQuestion: nextAskedNow.length > 0 ? mergedQuestions[nextAskedNow[0]] : null,
        reusedExisting: true,
        appendedQuestionCount: addedQuestionIndexes.length,
        newlyAskedQuestions: nextAskedNow.map((idx) => mergedQuestions[idx]).filter(Boolean),
      };
    }

    if (hasUnexpiredExisting && isSystemManagedDelegationEntry(existingDelegation)) {
      try {
        await pool.query(
          `
            INSERT INTO readiness_events (appointment_id, event_type, details)
            VALUES ($1::uuid, 'PRECHECK_INTERRUPTED', $2::jsonb)
          `,
          [
            appointmentId,
            JSON.stringify({
              interruptedAt: now.toISOString(),
              reason: 'MANUAL_DELEGATION_OVERRIDE',
              interruptedBy: input.userId,
              previousPrecheckSource: existingDelegation.source || 'PRECHECK_AUTOMATION',
            }),
          ],
        );
      } catch (error) {
        console.warn('[AGENT] Failed to record precheck interruption marker', {
          appointmentId,
          caregiverId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    delegations[appointmentId] = {
      appointmentId,
      active: true,
      objective,
      questions,
      questionItems,
      primaryQuestionIndexes: safePrimaryQuestionIndexes,
      optionalQuestionIndexes,
      delegationType,
      factCheckClarificationAsked: false,
      askedQuestionIndexes: [],
      resolvedQuestionIndexes: [],
      progressNotifiedIndexes: [],
      completionNotifiedAt: undefined,
      contextPacket: {
        ...(input.contextPacket || {}),
        delegationType,
        primaryQuestionCount: safePrimaryQuestionIndexes.length,
        optionalQuestionCount: optionalQuestionIndexes.length,
      },
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      source: 'CAREGIVER_MANUAL',
      systemManaged: false,
      precheckProfileId: undefined,
    };

    settings.delegations = delegations;
    await saveAgentSettings(input.userId, role || 'CAREGIVER', settings, { activateAgent: true });

    let firstValidQuestionIndex = -1;
    let kickoffAskedIndexes: number[] = [];
    if (delegationType === 'FACT_CHECK') {
      kickoffAskedIndexes = safePrimaryQuestionIndexes.slice(0, 2);
      firstValidQuestionIndex = kickoffAskedIndexes[0] ?? -1;
    } else {
      const primaryQuestions = safePrimaryQuestionIndexes.map((idx) => questions[idx]).filter(Boolean);
      const firstPrimaryRelative = await pickFirstClientAskableQuestionIndexWithLLM(primaryQuestions);
      if (firstPrimaryRelative >= 0 && firstPrimaryRelative < safePrimaryQuestionIndexes.length) {
        firstValidQuestionIndex = safePrimaryQuestionIndexes[firstPrimaryRelative];
      } else {
        firstValidQuestionIndex = await pickFirstClientAskableQuestionIndexWithLLM(questions);
      }
      if (firstValidQuestionIndex >= 0) {
        kickoffAskedIndexes = [firstValidQuestionIndex];
      }
    }
    const firstQuestion = firstValidQuestionIndex >= 0 ? questions[firstValidQuestionIndex] : null;

    const kickoffMessage =
      delegationType === 'FACT_CHECK' && kickoffAskedIndexes.length > 1
        ? [
            'Hi, I am assisting your caregiver right now. Quick questions:',
            ...kickoffAskedIndexes.map((idx, offset) => `${offset + 1}) ${questions[idx]}`),
            'Please answer what you know.',
          ].join('\n')
        : firstQuestion
          ? `Hi, I am assisting your caregiver right now. Quick first question: ${firstQuestion}`
          : `Hi, I am assisting your caregiver right now. I will keep you updated and help coordinate logistics.`;

    await pool.query(
      `
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1, 'AI_AGENT', $2, $3, true)
      `,
      [appointmentId, input.userId, kickoffMessage],
    );
    if (appointmentClientId) {
      try {
        await fanoutKickoffToWhatsApp({
          appointmentId,
          clientId: appointmentClientId,
          kickoffType: 'DELEGATION',
          kickoffMessage,
        });
      } catch (error) {
        console.warn('[WHATSAPP] Delegation kickoff fanout skipped due to non-blocking error', {
          appointmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (kickoffAskedIndexes.length > 0) {
      delegations[appointmentId].askedQuestionIndexes = kickoffAskedIndexes.slice().sort((a, b) => a - b);
      settings.delegations = delegations;
      await saveAgentSettings(input.userId, role || 'CAREGIVER', settings, { activateAgent: true });
    }

    return {
      ok: true,
      delegation: delegations[appointmentId],
      firstQuestion,
    };
  }

  async function maybeResumePrecheckAfterManualCompletion(input: {
    appointmentId: string;
    caregiverId: string;
    manualDelegationStartedAt?: string;
    manualDelegationEndedAt: string;
  }): Promise<void> {
    const appointmentId = String(input.appointmentId || '').trim();
    if (!appointmentId) return;

    const interruptionRes = await pool.query(
      `
        SELECT created_at::text AS created_at
        FROM readiness_events
        WHERE appointment_id = $1::uuid
          AND event_type = 'PRECHECK_INTERRUPTED'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [appointmentId],
    );
    if (interruptionRes.rows.length === 0) return;

    const interruptedAt = String(interruptionRes.rows[0]?.created_at || '').trim();
    if (!interruptedAt) return;
    const interruptedAtMs = Date.parse(interruptedAt);
    if (!Number.isFinite(interruptedAtMs)) return;

    const manualStartedAtMs = Date.parse(String(input.manualDelegationStartedAt || ''));
    if (Number.isFinite(manualStartedAtMs) && manualStartedAtMs + 60_000 < interruptedAtMs) {
      return;
    }

    const resumedAfterInterruptionRes = await pool.query(
      `
        SELECT 1
        FROM readiness_events
        WHERE appointment_id = $1::uuid
          AND event_type IN ('PRECHECK_RESUMED', 'PRECHECK_COMPLETED')
          AND created_at > $2::timestamptz
        LIMIT 1
      `,
      [appointmentId, interruptedAt],
    );
    if (resumedAfterInterruptionRes.rows.length > 0) return;

    const appointmentRes = await pool.query(
      `
        SELECT
          a.id::text AS appointment_id,
          a.start_time::text AS start_time,
          COALESCE(a.aloha_status, 'SCHEDULED') AS appointment_status,
          a.service_type,
          c.name AS client_name
        FROM appointments a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.id = $1::uuid
        LIMIT 1
      `,
      [appointmentId],
    );
    if (appointmentRes.rows.length === 0) return;

    const appointmentRow = appointmentRes.rows[0];
    const appointmentStatus = String(appointmentRow.appointment_status || 'SCHEDULED');
    if (appointmentStatus !== 'SCHEDULED') {
      return;
    }

    const criticalChecksRes = await pool.query(
      `
        SELECT check_type, status
        FROM readiness_checks
        WHERE appointment_id = $1::uuid
          AND check_type = ANY($2::text[])
      `,
      [appointmentId, PRECHECK_CRITICAL_CHECK_ORDER],
    );
    const statusByCheck = new Map<PrecheckCheckType, 'PENDING' | 'PASS' | 'FAIL'>();
    for (const checkType of PRECHECK_CRITICAL_CHECK_ORDER) {
      statusByCheck.set(checkType, 'PENDING');
    }
    for (const row of criticalChecksRes.rows) {
      const checkType = String(row.check_type || '').trim().toUpperCase() as PrecheckCheckType;
      if (!statusByCheck.has(checkType)) continue;
      const statusRaw = String(row.status || '').trim().toUpperCase();
      const status: 'PENDING' | 'PASS' | 'FAIL' =
        statusRaw === 'PASS' || statusRaw === 'FAIL' ? statusRaw : 'PENDING';
      statusByCheck.set(checkType, status);
    }

    const hasCriticalFail = PRECHECK_CRITICAL_CHECK_ORDER.some((checkType) => statusByCheck.get(checkType) === 'FAIL');
    const allCriticalPass = PRECHECK_CRITICAL_CHECK_ORDER.every((checkType) => statusByCheck.get(checkType) === 'PASS');
    if (allCriticalPass) {
      return;
    }

    const clientName = String(appointmentRow.client_name || 'there');

    if (hasCriticalFail) {
      const failedChecks = PRECHECK_CRITICAL_CHECK_ORDER.filter((checkType) => statusByCheck.get(checkType) === 'FAIL');
      const nowIso = new Date().toISOString();
      await pool.query(
        `
          INSERT INTO readiness_events (appointment_id, event_type, details)
          VALUES ($1::uuid, 'PRECHECK_ESCALATED', $2::jsonb)
        `,
        [
          appointmentId,
          JSON.stringify({
            escalatedAt: nowIso,
            reason: 'UNRESOLVED_CHECKS_AFTER_MANUAL_DELEGATION',
            failedChecks,
            interruptedAt,
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
          input.caregiverId,
          `Pre-readiness escalation: unresolved critical blockers remain after delegation (${failedChecks.join(', ')}). Caregiver follow-up is required.`,
        ],
      );
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
            outcome: 'ESCALATED',
            source: 'APPOINTMENT_MANAGEMENT_AFTER_MANUAL_DELEGATION',
          }),
        ],
      );
      return;
    }

    const precheckStartedRes = await pool.query(
      `
        SELECT created_at::text AS created_at
        FROM readiness_events
        WHERE appointment_id = $1::uuid
          AND event_type = 'PRECHECK_STARTED'
          AND created_at <= $2::timestamptz
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [appointmentId, interruptedAt],
    );
    const priorPrecheckStartedAt = String(precheckStartedRes.rows[0]?.created_at || '').trim();
    let hadPriorPrecheckResponse = false;
    if (priorPrecheckStartedAt) {
      const precheckReplyWindowEnd = String(input.manualDelegationStartedAt || input.manualDelegationEndedAt);
      const replyRes = await pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM messages
          WHERE appointment_id = $1::uuid
            AND created_at > $2::timestamptz
            AND created_at < $3::timestamptz
            AND sender_type IN ('FAMILY', 'COORDINATOR', 'CAREGIVER')
            AND COALESCE(is_agent, false) = false
        `,
        [appointmentId, priorPrecheckStartedAt, precheckReplyWindowEnd],
      );
      hadPriorPrecheckResponse = Number(replyRes.rows[0]?.count || 0) > 0;
    }

    await pool.query(
      `
        DELETE FROM readiness_events
        WHERE appointment_id = $1::uuid
          AND event_type = 'PRECHECK_COMPLETED'
      `,
      [appointmentId],
    );
    await pool.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        SELECT $1::uuid, 'PRECHECK_STARTED', $2::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM readiness_events
          WHERE appointment_id = $1::uuid
            AND event_type = 'PRECHECK_STARTED'
        )
      `,
      [
        appointmentId,
        JSON.stringify({
          startedBy: 'APPOINTMENT_MANAGEMENT_AFTER_MANUAL_DELEGATION',
          startedAt: new Date().toISOString(),
        }),
      ],
    );

    const serviceType = appointmentRow.service_type ? String(appointmentRow.service_type) : null;
    const profile = resolvePrecheckProfile(serviceType);
    const questionByCheck = new Map(profile.questions.map((q) => [q.checkType, q.prompt]));
    const unresolvedChecks = PRECHECK_CRITICAL_CHECK_ORDER.filter((checkType) => statusByCheck.get(checkType) !== 'PASS');
    const nextCheckType = hadPriorPrecheckResponse
      ? (unresolvedChecks[0] || PRECHECK_CRITICAL_CHECK_ORDER[0])
      : PRECHECK_CRITICAL_CHECK_ORDER[0];
    const nextQuestion =
      String(questionByCheck.get(nextCheckType) || '').trim() ||
      'Can you confirm access and readiness details for this appointment?';
    const nextQuestionIndex = profile.questions.findIndex((q) => q.checkType === nextCheckType);
    const safeNextQuestionIndex = nextQuestionIndex >= 0 ? nextQuestionIndex : 0;
    const restartMode = hadPriorPrecheckResponse ? 'RESUME_REMAINING' : 'RESTART_FROM_FIRST';
    const gracefulNotice = hadPriorPrecheckResponse
      ? `Hi ${clientName}, thanks for your patience. We paused pre-readiness questions while your caregiver handled another request. Let's resume now: ${nextQuestion}`
      : `Hi ${clientName}, thanks for your patience. We need to restart the quick pre-readiness check because the earlier flow was interrupted. First question: ${nextQuestion}`;
    await pool.query(
      `
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1::uuid, 'AI_AGENT', $2, $3, true)
      `,
      [appointmentId, input.caregiverId, gracefulNotice],
    );

    const now = new Date();
    const appointmentStart = new Date(String(appointmentRow.start_time || now.toISOString()));
    const precheckEndsAt =
      appointmentStart.getTime() > now.getTime()
        ? appointmentStart.toISOString()
        : new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const resolvedIndexes = profile.questions
      .map((question, idx) => (statusByCheck.get(question.checkType) === 'PASS' ? idx : -1))
      .filter((idx) => idx >= 0);
    const askedIndexes = [safeNextQuestionIndex];

    const { settings, role } = await getAgentSettings(input.caregiverId);
    const delegations = { ...(settings.delegations || {}) };
    delegations[appointmentId] = {
      appointmentId,
      active: true,
      objective: profile.objective,
      questions: profile.questions.map((q) => q.prompt),
      askedQuestionIndexes: askedIndexes,
      resolvedQuestionIndexes: resolvedIndexes,
      progressNotifiedIndexes: [],
      completionNotifiedAt: undefined,
      startedAt: now.toISOString(),
      endsAt: precheckEndsAt,
      source: 'PRECHECK_AUTOMATION',
      systemManaged: true,
      precheckProfileId: profile.id,
      delegationType: 'FACT_CHECK',
    };
    settings.delegations = delegations;
    await saveAgentSettings(input.caregiverId, role || 'CAREGIVER', settings, { activateAgent: true });

    const plannerSeed = {
      version: 1,
      profileId: profile.id,
      items: PRECHECK_CRITICAL_CHECK_ORDER.reduce((acc, checkType) => {
        const status = statusByCheck.get(checkType) || 'PENDING';
        const item: {
          question: string;
          status: 'PENDING' | 'PASS' | 'FAIL';
          askedAt?: string;
          answeredAt?: string;
        } = {
          question: String(questionByCheck.get(checkType) || ''),
          status,
        };
        if (checkType === nextCheckType) {
          item.askedAt = now.toISOString();
        }
        if (status === 'PASS') {
          item.answeredAt = now.toISOString();
        }
        acc[checkType] = item;
        return acc;
      }, {} as Record<PrecheckCheckType, any>),
    };
    await pool.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        VALUES ($1::uuid, 'PRECHECK_PLANNER', $2::jsonb)
      `,
      [appointmentId, JSON.stringify(plannerSeed)],
    );

    await pool.query(
      `
        INSERT INTO readiness_events (appointment_id, event_type, details)
        VALUES ($1::uuid, 'PRECHECK_RESUMED', $2::jsonb)
      `,
      [
        appointmentId,
        JSON.stringify({
          resumedAt: now.toISOString(),
          interruptedAt,
          mode: restartMode,
          nextCheckType,
          triggeredBy: 'MANUAL_DELEGATION_COMPLETION',
        }),
      ],
    );
  }

  function normalizeCommandText(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
    const denominator = Math.max(clientTokens.size, hintTokens.length);
    if (denominator <= 0) return 0;
    const overlapRatio = overlap / denominator;
    if (overlapRatio >= 0.99) return 95;
    return Math.round(overlapRatio * 80);
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

  function commandHasClientPronoun(command: string): boolean {
    const normalized = normalizeCommandText(command);
    if (!normalized) return false;
    return /\b(he|she|him|her|his|hers|they|them|their|the client|the patient)\b/.test(normalized);
  }

  function resolveClientReferenceFromContext(input: {
    command: string;
    appointments: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
    memory?: AssistantMemoryState;
  }): CaregiverAppointmentRow | null {
    const requestedId = String(input.requestedAppointmentId || '').trim();
    if (requestedId) {
      const direct = input.appointments.find((item) => item.appointmentId === requestedId);
      if (direct) return direct;
    }

    const explicitHint = extractClientHint(input.command) || extractClientHintFromKnownAppointments(input.command, input.appointments);
    if (explicitHint) {
      const explicitMatch = input.appointments
        .map((item) => ({
          item,
          score: scoreClientNameMatch(item.clientName, explicitHint),
        }))
        .filter((entry) => entry.score >= 60)
        .sort((a, b) => b.score - a.score)[0];
      if (explicitMatch?.item) {
        return explicitMatch.item;
      }
    }

    if (commandHasClientPronoun(input.command)) {
      const memoryAppointmentId = String(input.memory?.appointmentId || '').trim();
      if (memoryAppointmentId) {
        const byAppointment = input.appointments.find((item) => item.appointmentId === memoryAppointmentId);
        if (byAppointment) return byAppointment;
      }
      const memoryClientId = String(input.memory?.lastReferencedClientId || input.memory?.clientId || '').trim();
      if (memoryClientId) {
        const byClientId = input.appointments.find((item) => item.clientId === memoryClientId);
        if (byClientId) return byClientId;
      }
      const memoryClientName = String(input.memory?.lastReferencedClientName || input.memory?.clientName || '').trim();
      if (memoryClientName) {
        const byClientName = input.appointments
          .map((item) => ({ item, score: scoreClientNameMatch(item.clientName, memoryClientName) }))
          .filter((entry) => entry.score >= 70)
          .sort((a, b) => b.score - a.score)[0];
        if (byClientName?.item) return byClientName.item;
      }
    }

    return null;
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
    const memoryClientHint = memory?.lastReferencedClientName || memory?.clientName || '';
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

  async function extractExplicitClientReferenceWithLLM(command: string): Promise<string | null> {
    if (!config.openai.apiKey) return null;
    const text = String(command || '').trim();
    if (!text) return null;

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
              content: `Return JSON only.

Extract the explicitly referenced client/person name from the caregiver message.
If no specific person/client is referenced, return null.

Return:
{
  "clientReference": "string|null"
}`,
            },
            {
              role: 'user',
              content: `Caregiver message: ${text}`,
            },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return null;
      const parsed = tryParseJsonObject(raw) as { clientReference?: unknown } | null;
      if (!parsed) return null;
      const ref = parsed.clientReference;
      if (ref === null || ref === undefined) return null;
      const normalized = String(ref).trim();
      return normalized || null;
    } catch {
      return null;
    }
  }

  async function resolveAppointmentWithLLM(input: {
    appointments: CaregiverAppointmentRow[];
    command: string;
    requestedAppointmentId?: string;
    memory?: AssistantMemoryState;
  }): Promise<{ appointment: CaregiverAppointmentRow | null; explicitContext: boolean } | null> {
    if (!config.openai.apiKey || input.appointments.length === 0) {
      return null;
    }

    const appointmentSummary = input.appointments
      .slice(0, 60)
      .map(
        (row, idx) =>
          `${idx + 1}. appointmentId=${row.appointmentId}, client=${row.clientName}, start=${formatBusinessDateTime(row.startTime)}, status=${row.appointmentStatus}`,
      )
      .join('\n');
    const clientRoster = Array.from(
      new Set(
        input.appointments
          .map((row) => String(row.clientName || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 40);

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
              content: `Return JSON only.

Choose the best matching appointment for the caregiver command from the provided list.
If command does not reference a specific visit/client/date, choose null.
Also classify whether the command contains explicit appointment context.
If command explicitly names or points to a client/visit that is not present in the list, choose null.
Do not force a low-confidence match.

Return:
{
  "appointmentId": "string|null",
  "explicitContext": true|false
}`,
            },
            {
              role: 'user',
              content: [
                `Requested appointmentId: ${input.requestedAppointmentId || 'none'}`,
                `Memory appointmentId: ${input.memory?.appointmentId || 'none'}`,
                `Memory clientName: ${input.memory?.clientName || 'none'}`,
                `Command: ${input.command}`,
                `Client roster:\n${clientRoster.join('\n') || '(none)'}`,
                `Appointments:\n${appointmentSummary}`,
              ].join('\n\n'),
            },
          ],
        }),
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { appointmentId?: unknown; explicitContext?: unknown };
      const appointmentIdRaw = parsed?.appointmentId;
      const appointmentId =
        appointmentIdRaw === null || appointmentIdRaw === undefined
          ? null
          : String(appointmentIdRaw).trim() || null;
      let appointment = appointmentId
        ? input.appointments.find((row) => row.appointmentId === appointmentId) || null
        : null;
      const explicitContext = Boolean(parsed?.explicitContext);
      if (explicitContext) {
        const explicitClientReference = await extractExplicitClientReferenceWithLLM(input.command);
        if (explicitClientReference) {
          const matches = input.appointments
            .map((row) => ({
              row,
              score: scoreClientNameMatch(row.clientName, explicitClientReference),
            }))
            .filter((entry) => entry.score >= 60)
            .sort((a, b) => b.score - a.score);
          if (matches.length === 0) {
            appointment = null;
          } else if (!appointment || scoreClientNameMatch(appointment.clientName, explicitClientReference) < 60) {
            appointment = matches[0].row;
          }
        }
      }
      return {
        appointment,
        explicitContext,
      };
    } catch {
      return null;
    }
  }

  function hasExplicitAppointmentContext(input: {
    command: string;
    appointments: CaregiverAppointmentRow[];
    requestedAppointmentId?: string;
  }): boolean {
    if (String(input.requestedAppointmentId || '').trim()) return true;
    if (Boolean(parseBusinessDateHint(input.command))) return true;
    if (Boolean(extractClientHint(input.command))) return true;
    if (Boolean(extractClientHintFromKnownAppointments(input.command, input.appointments))) return true;
    return false;
  }

  function appendInferredContextDisclosure(
    response: string,
    input: {
      inferred: boolean;
      appointment: CaregiverAppointmentRow | null;
    },
  ): string {
    const base = String(response || '').trim();
    if (!input.inferred || !input.appointment) return base;
    const disclosure = `Using context: ${input.appointment.clientName} on ${formatBusinessDateTime(input.appointment.startTime)}.`;
    if (!base) return disclosure;
    if (base.toLowerCase().includes('using context:')) return base;
    return `${base}\n\n${disclosure}`;
  }

  function getCurrentBusinessDateIso(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function formatBusinessDateLabel(dateIso: string): string {
    return formatBusinessDateLabelPolicy(dateIso, BUSINESS_TIME_ZONE);
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

  function buildScheduleOverviewResponse(
    appointments: CaregiverAppointmentRow[],
    businessDate: string,
  ): string {
    return buildScheduleOverviewResponsePolicy(appointments, businessDate, {
      timeZone: BUSINESS_TIME_ZONE,
      currentBusinessDateIso: getCurrentBusinessDateIso(),
      nowMs: Date.now(),
    });
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

  type MapsPlanMode =
    | 'DAY_ROUTE'
    | 'BETWEEN_VISITS'
    | 'DAY_ROUTE_RETURN_HOME'
    | 'HOME_TO_CLIENT'
    | 'CLIENT_TO_HOME';

  async function interpretMapsPlanModeWithLLM(input: {
    command: string;
    businessDate: string;
    homeAddressKnown: boolean;
    hasTargetAppointment: boolean;
    appointments: CaregiverAppointmentRow[];
  }): Promise<MapsPlanMode> {
    if (!config.openai.apiKey) {
      return 'DAY_ROUTE';
    }

    const appointmentSummary = input.appointments
      .slice(0, 8)
      .map(
        (row, idx) =>
          `${idx + 1}. ${row.clientName} at ${formatBusinessTime(row.startTime)}-${formatBusinessTime(row.endTime)} (${row.locationAddress || 'no address'})`,
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
              content: `Return JSON only.

Classify the caregiver maps request into one mode:
- DAY_ROUTE: overall route plan for the day.
- BETWEEN_VISITS: only travel legs between appointments.
- DAY_ROUTE_RETURN_HOME: day route including return home at end.
- HOME_TO_CLIENT: one-leg route from home to a target client visit.
- CLIENT_TO_HOME: one-leg route from target client visit back home.

Use semantics and available context, not keyword lists.

Return:
{
  "mode": "DAY_ROUTE|BETWEEN_VISITS|DAY_ROUTE_RETURN_HOME|HOME_TO_CLIENT|CLIENT_TO_HOME"
}`,
            },
            {
              role: 'user',
              content: [
                `Home address known: ${input.homeAddressKnown ? 'yes' : 'no'}`,
                `Target appointment resolved: ${input.hasTargetAppointment ? 'yes' : 'no'}`,
                `Appointments on ${formatBusinessDateLabel(input.businessDate)}:`,
                appointmentSummary || '(none)',
                '',
                `Caregiver request: ${input.command}`,
              ].join('\n'),
            },
          ],
        }),
      });
      if (!response.ok) return 'DAY_ROUTE';
      const payload = (await response.json()) as any;
      const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return 'DAY_ROUTE';
      const parsed = JSON.parse(raw) as { mode?: unknown };
      const mode = String(parsed?.mode || '').trim().toUpperCase();
      const valid = new Set<MapsPlanMode>([
        'DAY_ROUTE',
        'BETWEEN_VISITS',
        'DAY_ROUTE_RETURN_HOME',
        'HOME_TO_CLIENT',
        'CLIENT_TO_HOME',
      ]);
      return valid.has(mode as MapsPlanMode) ? (mode as MapsPlanMode) : 'DAY_ROUTE';
    } catch {
      return 'DAY_ROUTE';
    }
  }

  async function buildMapsDayPlan(input: {
    userId: string;
    command: string;
    businessDate?: string;
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
    const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.businessDate || ''))
      ? String(input.businessDate)
      : getCurrentBusinessDateIso();
    const dateLabel = formatBusinessDateLabel(businessDate);
    const dayAppointments = (await loadCaregiverAppointments(input.userId, { businessDate })).filter(
      (row) => row.appointmentStatus !== 'CANCELLED',
    );

    if (dayAppointments.length === 0) {
      return {
        response: `No visits are scheduled on ${dateLabel}, so there is no route to calculate.`,
        legs: [],
        resolvedAppointment: null,
      };
    }

    const llmResolvedTarget = await resolveAppointmentWithLLM({
      appointments: dayAppointments,
      command: input.command,
      requestedAppointmentId: input.requestedAppointmentId,
    });
    const targetAppointment =
      llmResolvedTarget?.appointment ||
      (llmResolvedTarget?.explicitContext
        ? null
        : pickAppointmentForCommand(
            dayAppointments,
            input.command,
            input.requestedAppointmentId,
          ));
    const resolvedAppointment = targetAppointment
      ? {
          appointmentId: targetAppointment.appointmentId,
          clientId: targetAppointment.clientId,
          clientName: targetAppointment.clientName,
          appointmentStartTime: targetAppointment.startTime,
        }
      : null;

    const homeAddress = cleanAddress(input.homeAddressOverride) || (await loadCaregiverHomeAddress(input.userId)) || '';
    const mapsMode = await interpretMapsPlanModeWithLLM({
      command: input.command,
      businessDate,
      homeAddressKnown: Boolean(homeAddress),
      hasTargetAppointment: Boolean(targetAppointment),
      appointments: dayAppointments,
    });
    const needsHomeLeg =
      mapsMode === 'HOME_TO_CLIENT' ||
      mapsMode === 'CLIENT_TO_HOME' ||
      mapsMode === 'DAY_ROUTE_RETURN_HOME';
    const betweenOnly = mapsMode === 'BETWEEN_VISITS';
    const includeReturnHome = mapsMode === 'DAY_ROUTE_RETURN_HOME';

    if (needsHomeLeg && !homeAddress) {
      return {
        response: 'What is your home address so I can calculate that route?',
        legs: [],
        needsHomeAddress: true,
        resolvedAppointment,
      };
    }

    if ((mapsMode === 'HOME_TO_CLIENT' || mapsMode === 'CLIENT_TO_HOME') && targetAppointment) {
      const appointmentAddress = cleanAddress(targetAppointment.locationAddress);
      if (!appointmentAddress) {
        return {
          response: `I do not have a service address for ${targetAppointment.clientName}, so I cannot calculate that route yet.`,
          legs: [],
          resolvedAppointment,
        };
      }

      const leg = await estimateDriveLegWithGoogleMaps({
        origin: mapsMode === 'CLIENT_TO_HOME' ? appointmentAddress : homeAddress,
        destination: mapsMode === 'CLIENT_TO_HOME' ? homeAddress : appointmentAddress,
        departureTime: mapsMode === 'CLIENT_TO_HOME' ? targetAppointment.endTime : targetAppointment.startTime,
      });
      const directionLabel =
        mapsMode === 'CLIENT_TO_HOME'
          ? `${targetAppointment.clientName} -> home`
          : `home -> ${targetAppointment.clientName}`;
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

    const routeAppointments = dayAppointments.filter((row) => cleanAddress(row.locationAddress));
    if (routeAppointments.length === 0) {
      return {
        response: `Appointments on ${dateLabel} are missing location addresses, so I cannot calculate map travel times.`,
        legs: [],
        resolvedAppointment,
      };
    }

    const legRequests: Array<{ origin: string; destination: string; departureTime: string; label: string }> = [];
    if (!betweenOnly && homeAddress) {
      legRequests.push({
        origin: homeAddress,
        destination: cleanAddress(routeAppointments[0].locationAddress),
        departureTime: routeAppointments[0].startTime,
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
        `Estimated drive plan for ${dateLabel} (${routeAppointments.length} visit${routeAppointments.length === 1 ? '' : 's'}):`,
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
    const objective = trimmed
      ? trimmed.length > 220
        ? `${trimmed.slice(0, 217)}...`
        : trimmed
      : 'Collect the missing caregiver-requested details from client or family.';
    const question = trimmed
      ? `Can you help confirm this request: ${trimmed.slice(0, 140)}${trimmed.length > 140 ? '...' : ''}?`
      : 'Can you help confirm the missing details needed before this visit?';
    return {
      objective,
      questions: [question],
    };
  }

  function toDelegationContextHistoryLines(history: AssistantTurn[]): DelegationContextHistoryLine[] {
    return (history || [])
      .slice(-16)
      .map((turn) => ({
        role: turn.role,
        content: String(turn.content || '').trim(),
        createdAt: turn.createdAt,
      }))
      .filter((row) => row.content.length > 0);
  }

  function compactSnippet(text: string, limit = 180): string {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (compact.length <= limit) return compact;
    return `${compact.slice(0, limit - 1)}...`;
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

  function fallbackSelectEvidenceRows(
    evidenceRows: ClientMessageEvidenceRow[],
    snippetLimit: number,
  ): ClientMessageEvidenceRow[] {
    const prioritized = evidenceRows.filter(
      (row) => row.senderType !== 'AI_AGENT' && row.senderType !== 'SYSTEM',
    );
    const source = prioritized.length > 0 ? prioritized : evidenceRows;
    const selected: ClientMessageEvidenceRow[] = [];
    const seenAppointments = new Set<string>();

    for (const row of source) {
      if (selected.length >= snippetLimit) break;
      if (seenAppointments.has(row.appointmentId)) continue;
      selected.push(row);
      seenAppointments.add(row.appointmentId);
    }

    for (const row of source) {
      if (selected.length >= snippetLimit) break;
      if (selected.includes(row)) continue;
      selected.push(row);
    }

    for (const row of evidenceRows) {
      if (selected.length >= snippetLimit) break;
      if (selected.includes(row)) continue;
      selected.push(row);
    }

    return selected.slice(0, snippetLimit);
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
    const appointmentLimit = clampInteger(
      input.appointmentLimit,
      1,
      120,
      CLIENT_LOOKUP_DEFAULT_APPOINTMENT_LIMIT,
    );
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

    const appointmentScopeParams = [...params, String(appointmentLimit)];
    const appointmentScopeRes = await pool.query(
      `
        SELECT
          a.id::text AS appointment_id
        FROM appointments a
        ${whereSql}
        ORDER BY a.start_time DESC
        LIMIT $${appointmentScopeParams.length}::int
      `,
      appointmentScopeParams,
    );
    const scopedAppointmentIdsRaw = appointmentScopeRes.rows
      .map((row) => String(row.appointment_id || '').trim())
      .filter(Boolean);
    const scopedAppointmentIds = clampAppointmentIdsByLimit(scopedAppointmentIdsRaw, appointmentLimit);
    const scopedAppointmentCount = scopedAppointmentIds.length;
    if (scopedAppointmentCount === 0) {
      return {
        response: `No appointments were found for ${input.clientName}.`,
        scannedAppointments: 0,
        scannedMessages: 0,
        evidence: [],
      };
    }

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
        WHERE m.appointment_id = ANY($1::uuid[])
        ORDER BY m.created_at DESC
        LIMIT $2::int
      `,
      [scopedAppointmentIds, String(messageLimit)],
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
        scannedAppointments: scopedAppointmentCount,
        scannedMessages: 0,
        evidence: [],
      };
    }

    const llmSelected = await selectRelevantEvidenceWithLLM({
      question: input.question,
      clientName: input.clientName,
      evidenceRows,
      snippetLimit,
    });
    const selected = llmSelected || fallbackSelectEvidenceRows(evidenceRows, snippetLimit);

    if (selected.length === 0) {
      return {
        response: `I searched ${evidenceRows.length} messages for ${input.clientName}, but I could not find enough detail to answer "${input.question.trim()}".`,
        scannedAppointments: scopedAppointmentCount,
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
      scannedAppointments: scopedAppointmentCount,
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
                'You are a caregiver logistics assistant. Answer strictly from provided evidence. State concrete facts directly when they are present, and if evidence is insufficient, say that briefly. Keep the answer concise (2-4 sentences).',
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

  // POST /testing/channel-endpoints/upsert
  // Local demo helper to map WhatsApp endpoints to known entities.
  app.post('/testing/channel-endpoints/upsert', async (req: Request, res: Response) => {
    try {
      const provider = String(req.body?.provider || 'twilio_whatsapp').trim().toLowerCase();
      const endpoint = normalizeWhatsAppEndpoint(req.body?.endpoint);
      const entityType = String(req.body?.entityType || '').trim().toUpperCase();
      const entityId = String(req.body?.entityId || '').trim();
      const verified = Boolean(req.body?.verified);
      const active = req.body?.active === undefined ? true : Boolean(req.body?.active);
      const metadataInput =
        req.body?.metadata && typeof req.body.metadata === 'object' ? (req.body.metadata as Record<string, unknown>) : {};
      const optInStatus = String(metadataInput.opt_in_status || '').trim().toUpperCase();
      const allowedOptInStatus = new Set(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN', 'PENDING']);
      const metadata: Record<string, unknown> = {
        ...metadataInput,
      };
      if (allowedOptInStatus.has(optInStatus)) {
        metadata.opt_in_status = optInStatus;
      }
      if (metadataInput.opt_in_source !== undefined) {
        metadata.opt_in_source = String(metadataInput.opt_in_source || '').trim();
      }
      if (metadataInput.opt_in_at !== undefined) {
        metadata.opt_in_at = String(metadataInput.opt_in_at || '').trim();
      }
      if (metadataInput.locale !== undefined) {
        metadata.locale = String(metadataInput.locale || '').trim();
      }
      if (metadataInput.last_delivery_status !== undefined) {
        metadata.last_delivery_status = String(metadataInput.last_delivery_status || '').trim().toUpperCase();
      }

      if (provider !== 'twilio_whatsapp') {
        return res.status(400).json({ error: 'provider must be twilio_whatsapp' });
      }
      if (!endpoint) {
        return res.status(400).json({ error: 'Valid endpoint is required (E.164 phone)' });
      }
      if (!entityId) {
        return res.status(400).json({ error: 'entityId is required' });
      }
      if (!['CLIENT', 'CAREGIVER', 'COORDINATOR'].includes(entityType)) {
        return res.status(400).json({ error: 'entityType must be CLIENT, CAREGIVER, or COORDINATOR' });
      }

      const result = await pool.query(
        `
          INSERT INTO channel_endpoints (
            provider,
            endpoint,
            entity_type,
            entity_id,
            active,
            verified,
            metadata,
            updated_at
          )
          VALUES ($1, $2, $3, $4::uuid, $5, $6, $7::jsonb, NOW())
          ON CONFLICT (provider, endpoint, entity_type, entity_id)
          DO UPDATE SET
            active = EXCLUDED.active,
            verified = EXCLUDED.verified,
            metadata = channel_endpoints.metadata || EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING
            id::text AS id,
            provider,
            endpoint,
            entity_type AS "entityType",
            entity_id::text AS "entityId",
            active,
            verified,
            metadata,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [provider, endpoint, entityType, entityId, active, verified, JSON.stringify(metadata)],
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('Failed to upsert channel endpoint', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/testing/channel-endpoints', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `
          SELECT
            id::text AS id,
            provider,
            endpoint,
            entity_type AS "entityType",
            entity_id::text AS "entityId",
            active,
            verified,
            metadata,
            last_seen_at AS "lastSeenAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM channel_endpoints
          ORDER BY updated_at DESC
          LIMIT 200
        `,
      );
      res.json({ success: true, data: result.rows });
    } catch (error) {
      console.error('Failed to list channel endpoints', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /testing/whatsapp/replay-failed-inbound
  // Replays inbound webhook events previously marked as FAILED_PROCESSING_RETRYABLE.
  app.post('/testing/whatsapp/replay-failed-inbound', async (req: Request, res: Response) => {
    try {
      const limitRaw = Number(req.body?.limit || req.query.limit || 50);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 50;

      const result = await pool.query(
        `
          SELECT
            provider_message_id,
            payload
          FROM webhook_inbox_events
          WHERE provider = 'twilio_whatsapp'
            AND status = 'FAILED_PROCESSING_RETRYABLE'
          ORDER BY created_at ASC
          LIMIT $1
        `,
        [limit],
      );

      let replayed = 0;
      const skipped: Array<{ messageSid: string; reason: string }> = [];
      for (const row of result.rows) {
        const messageSid = String(row.provider_message_id || '').trim();
        const payload = (row.payload || {}) as Record<string, unknown>;
        const appointmentId = String(payload.appointmentId || '').trim();
        const senderId = String(payload.senderId || '').trim();
        const messageId = String(payload.messageId || '').trim();
        const text = String(payload.text || '').trim();
        const fromEndpoint = normalizeWhatsAppEndpoint(payload.fromEndpoint);
        const toEndpoint = normalizeWhatsAppEndpoint(payload.toEndpoint);

        if (!messageSid || !appointmentId || !senderId || !messageId || !text) {
          skipped.push({ messageSid: messageSid || 'unknown', reason: 'MISSING_REQUIRED_REPLAY_FIELDS' });
          continue;
        }

        await publishMessage(sqsClient, QUEUES.INCOMING_MESSAGES, {
          type: 'NEW_MESSAGE',
          appointmentId,
          text,
          senderType: 'FAMILY',
          senderId,
          messageId,
          channel: 'WHATSAPP',
          provider: 'TWILIO_WHATSAPP',
          fromEndpoint,
          toEndpoint,
          externalMessageId: messageSid,
        });
        await pool.query(
          `
            UPDATE webhook_inbox_events
            SET status = 'REPLAYED_QUEUED',
                payload = payload || $3::jsonb,
                processed_at = NOW()
            WHERE provider = $1 AND provider_message_id = $2
          `,
          ['twilio_whatsapp', messageSid, JSON.stringify({ replayedAt: new Date().toISOString() })],
        );
        replayed += 1;
      }

      res.json({
        success: true,
        data: {
          attempted: result.rows.length,
          replayed,
          skipped,
        },
      });
    } catch (error) {
      console.error('Failed to replay WhatsApp failed inbound events', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /testing/whatsapp/prune-webhook-events
  // Deletes old webhook_inbox_events rows based on retention period.
  app.post('/testing/whatsapp/prune-webhook-events', async (req: Request, res: Response) => {
    try {
      const daysRaw = Number(req.body?.retentionDays || req.query.retentionDays || config.whatsapp.statusRetentionDays);
      const retentionDays = Number.isFinite(daysRaw) ? Math.max(1, Math.min(3650, Math.trunc(daysRaw))) : config.whatsapp.statusRetentionDays;

      const deleteResult = await pool.query(
        `
          DELETE FROM webhook_inbox_events
          WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
          RETURNING id
        `,
        [retentionDays],
      );

      res.json({
        success: true,
        data: {
          retentionDays,
          deletedCount: deleteResult.rowCount || 0,
        },
      });
    } catch (error) {
      console.error('Failed to prune WhatsApp webhook events', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/auth/accounts', async (req: Request, res: Response) => {
    try {
      const role = String(req.query.role || '').toUpperCase();
      const allowedRoles = new Set(['CAREGIVER', 'FAMILY', 'COORDINATOR']);
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
      const accounts = result.rows.map((row) => ({
        username: row.username,
        role: row.role,
        userId: row.person_id,
        name: row.display_name,
      }));
      const includeLocalCoordinator = LOCAL_COORDINATOR_FALLBACK_ENABLED && (!role || role === 'COORDINATOR');
      const hasLocalCoordinator = accounts.some(
        (entry) => String(entry.username || '').trim().toLowerCase() === LOCAL_COORDINATOR_USERNAME.toLowerCase(),
      );
      if (includeLocalCoordinator && !hasLocalCoordinator) {
        accounts.unshift({
          username: LOCAL_COORDINATOR_USERNAME,
          role: 'COORDINATOR',
          userId: LOCAL_COORDINATOR_USER_ID,
          name: LOCAL_COORDINATOR_DISPLAY_NAME,
        });
      }

      res.json({
        data: accounts,
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
        const normalizedUsername = username.toLowerCase();
        const localCoordinatorEnabled =
          LOCAL_COORDINATOR_FALLBACK_ENABLED && normalizedUsername === LOCAL_COORDINATOR_USERNAME.toLowerCase();
        if (!localCoordinatorEnabled || password !== LOCAL_COORDINATOR_PASSWORD) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        const sessionUser: SessionUser = {
          userId: LOCAL_COORDINATOR_USER_ID,
          role: 'COORDINATOR',
          displayName: LOCAL_COORDINATOR_DISPLAY_NAME,
          username: LOCAL_COORDINATOR_USERNAME,
        };
        sessions.set(token, sessionUser);
        return res.json({
          token,
          user: {
            userId: sessionUser.userId,
            role: sessionUser.role,
            name: sessionUser.displayName,
            username: sessionUser.username,
          },
        });
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
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      // 1. Extract identity from authenticated session only.
      const { date } = req.query;
      const targetId = sessionUser.userId;
      const effectiveRole = String(sessionUser.role || '').toUpperCase();
      const requestedDate = String(date || '').trim();
      const hasDateFilter = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);

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
          a.client_id::text AS client_id,
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
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!['CAREGIVER', 'COORDINATOR'].includes(sessionUser.role)) {
        return res.status(403).json({ error: 'Only caregivers or coordinators can update readiness checks' });
      }
      const { id } = req.params;
      const appointmentScope = await loadAppointmentScope(id);
      if (!appointmentScope) {
        return res.status(404).json({ error: 'Appointment not found' });
      }
      if (!canSessionAccessAppointment(sessionUser, appointmentScope)) {
        return res.status(403).json({ error: 'You are not allowed to update readiness for this appointment' });
      }
      const checkType = String(req.body.checkType || '').trim().toUpperCase();
      const status = String(req.body.status || '').trim().toUpperCase();
      const sourceRaw = String(req.body.source || 'MANUAL').trim();
      const overrideReason = String(req.body.overrideReason || '').trim();

      if (!checkType || !status) {
        return res.status(400).json({ error: 'checkType and status are required' });
      }
      if (!READINESS_CHECKS.some((c) => c.key === checkType)) {
        return res.status(400).json({ error: `Unknown checkType: ${checkType}` });
      }
      if (!['PENDING', 'PASS', 'FAIL'].includes(status)) {
        return res.status(400).json({ error: `Invalid status: ${status}` });
      }

      const existingRes = await pool.query(
        `
          SELECT status
          FROM readiness_checks
          WHERE appointment_id = $1::uuid
            AND check_type = $2
          LIMIT 1
        `,
        [id, checkType],
      );
      const previousStatus = String(existingRes.rows[0]?.status || '').trim().toUpperCase() || 'PENDING';
      const isCoordinatorOverride = sessionUser.role === 'COORDINATOR' && previousStatus === 'FAIL' && status === 'PASS';
      if (isCoordinatorOverride && !overrideReason) {
        return res.status(400).json({ error: 'overrideReason is required for coordinator FAIL -> PASS override' });
      }

      const finalSource = isCoordinatorOverride
        ? 'SCHEDULER_MANUAL_OVERRIDE'
        : (sourceRaw || 'MANUAL');

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
        [id, checkType, status, finalSource]
      );

      if (isCoordinatorOverride) {
        await pool.query(
          `
            INSERT INTO readiness_events (appointment_id, event_type, details)
            VALUES ($1::uuid, 'READINESS_CHECK_OVERRIDDEN', $2::jsonb)
          `,
          [
            id,
            JSON.stringify({
              checkType,
              previousStatus,
              nextStatus: status,
              overrideReason,
              overrideSource: 'SCHEDULER_MANUAL_OVERRIDE',
              overriddenBy: {
                userId: sessionUser.userId,
                role: sessionUser.role,
                name: sessionUser.displayName,
              },
              timestamp: new Date().toISOString(),
            }),
          ],
        );
      }

      await publishMessage(sqsClient, QUEUES.READINESS_EVALUATION, {
        messageId: `manual-${Date.now()}`,
        appointmentId: id,
        trigger: 'MANUAL',
        timestamp: new Date().toISOString(),
      });

      res.json({
        success: true,
        data: {
          appointmentId: id,
          checkType,
          status,
          source: finalSource,
          previousStatus,
          overridden: isCoordinatorOverride,
        },
      });
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

  // POST /webhooks/twilio/whatsapp/inbound
  // Twilio WhatsApp inbound webhook for production traffic.
  app.post('/webhooks/twilio/whatsapp/inbound', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const messageSid = String(req.body?.MessageSid || '').trim();
    const fromRaw = String(req.body?.From || '').trim();
    const toRaw = String(req.body?.To || '').trim();
    const rawBodyText = String(req.body?.Body || '').trim();
    const numMedia = Math.max(0, Math.trunc(Number(req.body?.NumMedia || '0')));

    const upsertInboundEvent = async (status: string, patchPayload?: Record<string, unknown>) => {
      if (!messageSid) return;
      await pool.query(
        `
          UPDATE webhook_inbox_events
          SET status = $3,
              payload = payload || $4::jsonb,
              processed_at = NOW()
          WHERE provider = $1 AND provider_message_id = $2
        `,
        ['twilio_whatsapp', messageSid, status, JSON.stringify(patchPayload || {})],
      );
    };

    try {
      if (!config.whatsapp.enabled) {
        return res.status(503).json({ error: 'WhatsApp integration is disabled' });
      }

      if (!isValidTwilioSignature(req)) {
        metric('signature_invalid', { endpoint: '/webhooks/twilio/whatsapp/inbound' });
        return res.status(401).json({ error: 'Invalid Twilio signature' });
      }

      if (!messageSid) {
        return res.status(400).json({ error: 'MessageSid is required' });
      }

      const dedupeInsert = await pool.query(
        `
          INSERT INTO webhook_inbox_events (
            provider,
            provider_message_id,
            event_type,
            status,
            payload
          )
          VALUES ($1, $2, 'INBOUND', 'RECEIVED', $3::jsonb)
          ON CONFLICT (provider, provider_message_id) DO NOTHING
          RETURNING id
        `,
        ['twilio_whatsapp', messageSid, JSON.stringify(req.body || {})],
      );
      if (dedupeInsert.rows.length === 0) {
        metric('inbound_deduped', { messageSid });
        return sendTwilioXmlAck(res);
      }

      const fromEndpoint = normalizeWhatsAppEndpoint(fromRaw);
      const toEndpoint = normalizeWhatsAppEndpoint(toRaw);
      if (!fromEndpoint) {
        await upsertInboundEvent('IGNORED_INVALID_FROM');
        metric('inbound_ignored', { reason: 'IGNORED_INVALID_FROM' });
        return sendTwilioXmlAck(res);
      }

      if (!isWhatsAppAllowlisted(fromEndpoint)) {
        await upsertInboundEvent('IGNORED_NOT_ALLOWLISTED', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_NOT_ALLOWLISTED', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }

      if (numMedia > 0) {
        await upsertInboundEvent('IGNORED_UNSUPPORTED_MEDIA', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_UNSUPPORTED_MEDIA', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }

      const bodyText = rawBodyText.slice(0, config.whatsapp.maxInboundChars);
      if (!bodyText) {
        await upsertInboundEvent('IGNORED_EMPTY_BODY', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_EMPTY_BODY', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }

      if (rawBodyText.length > config.whatsapp.maxInboundChars) {
        await upsertInboundEvent('IGNORED_BODY_TOO_LONG', {
          fromEndpoint,
          toEndpoint,
          bodyLength: rawBodyText.length,
          maxInboundChars: config.whatsapp.maxInboundChars,
        });
        metric('inbound_ignored', {
          reason: 'IGNORED_BODY_TOO_LONG',
          fromEndpoint: redactPhoneForLogs(fromEndpoint),
          bodyLength: rawBodyText.length,
        });
        return sendTwilioXmlAck(res);
      }

      if (await isRateLimitedEndpoint(fromEndpoint)) {
        await upsertInboundEvent('IGNORED_RATE_LIMITED', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_RATE_LIMITED', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }

      const binding = await resolveWhatsAppEndpointBinding(fromEndpoint);
      if (!binding) {
        await upsertInboundEvent('IGNORED_UNMAPPED_ENDPOINT', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_UNMAPPED_ENDPOINT', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }
      if (!binding.active || binding.blocked) {
        await upsertInboundEvent('IGNORED_BLOCKED_ENDPOINT', {
          fromEndpoint,
          toEndpoint,
          active: binding.active,
          blocked: binding.blocked,
        });
        metric('inbound_ignored', { reason: 'IGNORED_BLOCKED_ENDPOINT', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }
      if (!config.whatsapp.trialMode && !binding.verified) {
        await upsertInboundEvent('IGNORED_UNVERIFIED_ENDPOINT', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_UNVERIFIED_ENDPOINT', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }
      const mappedClientId = binding.clientId;

      await pool.query(
        `
          UPDATE channel_endpoints
          SET last_seen_at = NOW(), updated_at = NOW()
          WHERE provider = 'twilio_whatsapp'
            AND endpoint = $1
            AND entity_type = 'CLIENT'
            AND entity_id = $2::uuid
        `,
        [fromEndpoint, mappedClientId],
      );

      const appointmentScope = await resolveOperationalAppointmentForClient(mappedClientId);
      if (!appointmentScope?.appointmentId) {
        await upsertInboundEvent('IGNORED_NO_APPOINTMENT_CONTEXT', { fromEndpoint, toEndpoint });
        metric('inbound_ignored', { reason: 'IGNORED_NO_APPOINTMENT_CONTEXT', fromEndpoint: redactPhoneForLogs(fromEndpoint) });
        return sendTwilioXmlAck(res);
      }

      const messageInsert = await pool.query(
        `
          INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent, channel)
          VALUES ($1::uuid, 'FAMILY', $2, $3, false, 'WHATSAPP')
          RETURNING id, created_at
        `,
        [appointmentScope.appointmentId, mappedClientId, bodyText],
      );
      const newMessage = messageInsert.rows[0];

      try {
        await publishMessage(sqsClient, QUEUES.INCOMING_MESSAGES, {
          type: 'NEW_MESSAGE',
          appointmentId: appointmentScope.appointmentId,
          text: bodyText,
          senderType: 'FAMILY',
          senderId: mappedClientId,
          messageId: newMessage.id,
          channel: 'WHATSAPP',
          provider: 'TWILIO_WHATSAPP',
          fromEndpoint,
          toEndpoint,
          externalMessageId: messageSid,
        });
      } catch (publishError) {
        await upsertInboundEvent('FAILED_PROCESSING_RETRYABLE', {
          appointmentId: appointmentScope.appointmentId,
          messageId: newMessage.id,
          senderId: mappedClientId,
          fromEndpoint,
          toEndpoint,
          text: bodyText,
          queue: QUEUES.INCOMING_MESSAGES,
          queuePublishError: publishError instanceof Error ? publishError.message : String(publishError),
        });
        metric('inbound_failed_retryable', {
          reason: 'QUEUE_PUBLISH_FAILED',
          fromEndpoint: redactPhoneForLogs(fromEndpoint),
        });
        return sendTwilioXmlAck(res);
      }

      await upsertInboundEvent('PROCESSED', {
        appointmentId: appointmentScope.appointmentId,
        messageId: newMessage.id,
        senderId: mappedClientId,
        text: bodyText,
        fromEndpoint,
        toEndpoint,
      });
      metric('inbound_processed', {
        fromEndpoint: redactPhoneForLogs(fromEndpoint),
        latencyMs: Date.now() - startedAt,
      });

      return sendTwilioXmlAck(res);
    } catch (error) {
      await upsertInboundEvent('FAILED_PROCESSING_RETRYABLE', {
        error: error instanceof Error ? error.message : String(error),
        from: config.whatsapp.redactLogs ? undefined : fromRaw,
      });
      metric('inbound_failed_retryable', {
        reason: 'UNHANDLED',
        messageSid: messageSid || null,
      });
      console.error('Failed Twilio WhatsApp inbound webhook', error);
      return sendTwilioXmlAck(res);
    }
  });

  // POST /webhooks/twilio/whatsapp/status
  // Twilio WhatsApp delivery status callback.
  app.post('/webhooks/twilio/whatsapp/status', async (req: Request, res: Response) => {
    try {
      if (!config.whatsapp.enabled) {
        return res.status(503).json({ error: 'WhatsApp integration is disabled' });
      }

      if (!isValidTwilioSignature(req)) {
        metric('signature_invalid', { endpoint: '/webhooks/twilio/whatsapp/status' });
        return res.status(401).json({ error: 'Invalid Twilio signature' });
      }

      const messageSid = String(req.body?.MessageSid || '').trim();
      const messageStatus = String(req.body?.MessageStatus || req.body?.SmsStatus || '').trim().toUpperCase();
      const toEndpoint = normalizeWhatsAppEndpoint(req.body?.To);
      if (!messageSid) {
        return res.status(400).json({ error: 'MessageSid is required' });
      }

      await pool.query(
        `
          INSERT INTO webhook_inbox_events (
            provider,
            provider_message_id,
            event_type,
            status,
            payload,
            processed_at
          )
          VALUES ($1, $2, 'STATUS', $3, $4::jsonb, NOW())
          ON CONFLICT (provider, provider_message_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            event_type = EXCLUDED.event_type,
            payload = webhook_inbox_events.payload || EXCLUDED.payload,
            processed_at = NOW()
        `,
        ['twilio_whatsapp_outbound', messageSid, messageStatus || 'UNKNOWN', JSON.stringify(req.body || {})],
      );
      if (toEndpoint) {
        await pool.query(
          `
            UPDATE channel_endpoints
            SET metadata = metadata || $2::jsonb,
                updated_at = NOW()
            WHERE provider = 'twilio_whatsapp'
              AND endpoint = $1
              AND entity_type = 'CLIENT'
          `,
          [toEndpoint, JSON.stringify({ last_delivery_status: messageStatus || 'UNKNOWN' })],
        );
      }
      metric('outbound_status_updated', {
        messageStatus: messageStatus || 'UNKNOWN',
        toEndpoint: redactPhoneForLogs(toEndpoint),
      });

      return sendTwilioXmlAck(res);
    } catch (error) {
      console.error('Failed Twilio WhatsApp status webhook', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /messages
  app.post('/messages', async (req: Request, res: Response) => {
    try {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const appointmentId = String(req.body.appointmentId || '').trim();
      const content = String(req.body.content || '').trim();
      if (!appointmentId || !content) {
        return res.status(400).json({ error: 'appointmentId and content are required' });
      }

      const appointmentScope = await loadAppointmentScope(appointmentId);
      if (!appointmentScope) {
        return res.status(404).json({ error: 'Appointment not found' });
      }
      if (!canSessionAccessAppointment(sessionUser, appointmentScope)) {
        return res.status(403).json({ error: 'You are not allowed to post messages for this appointment' });
      }

      const finalSenderType = senderTypeForSessionRole(sessionUser.role);
      const finalSenderId = sessionUser.userId;

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
        messageId: newMessage.id,
        channel: 'APP',
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
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const appointmentScope = await loadAppointmentScope(id);
      if (!appointmentScope) {
        return res.status(404).json({ error: 'Appointment not found' });
      }
      if (!canSessionAccessAppointment(sessionUser, appointmentScope)) {
        return res.status(403).json({ error: 'You are not allowed to view messages for this appointment' });
      }

      const role = String(sessionUser.role || '').toUpperCase();
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

  // GET /scheduler/threads
  // Coordinator view of caregiver-scoped scheduler threads and open escalation counts.
  app.get('/scheduler/threads', async (req: Request, res: Response) => {
    try {
      if (!authorizeCoordinatorAccess(req, res)) return;

      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 100;

      const result = await pool.query(
        `
          WITH open_counts AS (
            SELECT
              caregiver_id,
              COUNT(*)::int AS open_count
            FROM escalations
            WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'ACTION_REQUESTED')
            GROUP BY caregiver_id
          ),
          last_messages AS (
            SELECT
              t.caregiver_id,
              MAX(m.created_at) AS last_message_at
            FROM scheduler_threads t
            LEFT JOIN scheduler_thread_messages m ON m.thread_id = t.id
            GROUP BY t.caregiver_id
          )
          SELECT
            c.id::text AS caregiver_id,
            c.name AS caregiver_name,
            COALESCE(t.id::text, '') AS thread_id,
            COALESCE(o.open_count, 0)::int AS open_escalation_count,
            0::int AS unread_count,
            COALESCE(l.last_message_at, t.updated_at, c.updated_at, c.created_at)::text AS last_activity_at
          FROM caregivers c
          LEFT JOIN scheduler_threads t ON t.caregiver_id = c.id::text
          LEFT JOIN open_counts o ON o.caregiver_id = c.id::text
          LEFT JOIN last_messages l ON l.caregiver_id = c.id::text
          ORDER BY
            CASE WHEN COALESCE(o.open_count, 0) > 0 THEN 0 ELSE 1 END,
            COALESCE(l.last_message_at, t.updated_at, c.updated_at, c.created_at) DESC,
            c.name ASC
          LIMIT $1::int
        `,
        [limit],
      );

      res.json({
        data: result.rows.map((row) => ({
          caregiverId: String(row.caregiver_id || ''),
          caregiverName: String(row.caregiver_name || ''),
          threadId: String(row.thread_id || '').trim() || null,
          openEscalationCount: Number(row.open_escalation_count || 0),
          unreadCount: Number(row.unread_count || 0),
          lastActivityAt: String(row.last_activity_at || ''),
        })),
      });
    } catch (error) {
      console.error('Failed to load scheduler threads', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /scheduler/threads/:caregiverId/messages
  // Fetches scheduler thread messages for coordinator or the owning caregiver.
  app.get('/scheduler/threads/:caregiverId/messages', async (req: Request, res: Response) => {
    try {
      const caregiverId = String(req.params.caregiverId || '').trim();
      if (!caregiverId) {
        return res.status(400).json({ error: 'caregiverId is required' });
      }

      const sessionUser = authorizeSchedulerThreadAccess(req, res, caregiverId);
      if (!sessionUser) return;

      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 100;
      const before = String(req.query.before || '').trim() || undefined;
      const payload = await listSchedulerThreadMessages({ caregiverId, limit, before });

      res.json({
        data: payload.messages,
        threadId: payload.threadId,
      });
    } catch (error) {
      console.error('Failed to load scheduler thread messages', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /scheduler/threads/:caregiverId/messages
  // Posts a caregiver/coordinator message in the scheduler thread.
  app.post('/scheduler/threads/:caregiverId/messages', async (req: Request, res: Response) => {
    try {
      const caregiverId = String(req.params.caregiverId || '').trim();
      if (!caregiverId) {
        return res.status(400).json({ error: 'caregiverId is required' });
      }
      const sessionUser = authorizeSchedulerThreadAccess(req, res, caregiverId);
      if (!sessionUser) return;

      const content = String(req.body.content || '').trim();
      if (!content) {
        return res.status(400).json({ error: 'content is required' });
      }

      const escalationIdRaw = String(req.body.escalationId || '').trim();
      const escalationId = escalationIdRaw ? normalizeOptionalUuid(escalationIdRaw) : undefined;
      if (escalationIdRaw && !escalationId) {
        return res.status(400).json({ error: 'escalationId must be a valid UUID' });
      }
      if (escalationId) {
        const escalationRes = await pool.query(
          `
            SELECT caregiver_id::text AS caregiver_id
            FROM escalations
            WHERE id = $1::uuid
            LIMIT 1
          `,
          [escalationId],
        );
        if (escalationRes.rows.length === 0) {
          return res.status(404).json({ error: 'Escalation not found' });
        }
        const ownerCaregiverId = String(escalationRes.rows[0]?.caregiver_id || '').trim();
        if (ownerCaregiverId !== caregiverId) {
          return res.status(400).json({ error: 'escalationId does not belong to this caregiver thread' });
        }
      }

      const metadata = req.body.metadata && typeof req.body.metadata === 'object'
        ? (req.body.metadata as Record<string, unknown>)
        : {};
      const senderType: SchedulerThreadActorType =
        sessionUser.role === 'COORDINATOR' ? 'COORDINATOR' : 'CAREGIVER';
      const message = await appendSchedulerThreadMessage({
        caregiverId,
        senderType,
        senderId: sessionUser.userId,
        content,
        escalationId,
        metadata,
      });
      const metadataEventType = String((metadata as any).eventType || (metadata as any).event_type || '')
        .trim()
        .toUpperCase();
      if (metadataEventType === 'SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT' && sessionUser.role === 'COORDINATOR') {
        const eventAppointmentIdRaw = String((metadata as any).appointmentId || req.body.appointmentId || '').trim();
        const eventAppointmentId = eventAppointmentIdRaw
          ? normalizeOptionalUuid(eventAppointmentIdRaw)
          : undefined;
        if (eventAppointmentId) {
          const appointmentScope = await loadAppointmentScope(eventAppointmentId);
          if (appointmentScope && canSessionAccessAppointment(sessionUser, appointmentScope)) {
            await pool.query(
              `
                INSERT INTO readiness_events (appointment_id, event_type, details)
                VALUES ($1::uuid, 'SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT', $2::jsonb)
              `,
              [
                eventAppointmentId,
                JSON.stringify({
                  threadId: message.threadId,
                  escalationId: escalationId || null,
                  caregiverId,
                  coordinatorId: sessionUser.userId,
                  coordinatorName: sessionUser.displayName,
                  createdAt: new Date().toISOString(),
                }),
              ],
            );
          }
        }
      }

      res.json({ success: true, data: message });
    } catch (error) {
      console.error('Failed to post scheduler thread message', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /escalations
  // Lists escalations for coordinator (all) or caregiver (own only).
  app.get('/escalations', async (req: Request, res: Response) => {
    try {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!['CAREGIVER', 'COORDINATOR'].includes(sessionUser.role)) {
        return res.status(403).json({ error: 'Only caregivers or coordinators can access escalations' });
      }

      const clauses: string[] = [];
      const params: any[] = [];

      if (sessionUser.role === 'CAREGIVER') {
        clauses.push(`caregiver_id = $${params.length + 1}`);
        params.push(sessionUser.userId);
      } else {
        const caregiverIdFilter = String(req.query.caregiverId || '').trim();
        if (caregiverIdFilter) {
          clauses.push(`caregiver_id = $${params.length + 1}`);
          params.push(caregiverIdFilter);
        }
      }

      const appointmentIdRaw = String(req.query.appointmentId || '').trim();
      const appointmentId = appointmentIdRaw ? normalizeOptionalUuid(appointmentIdRaw) : undefined;
      if (appointmentIdRaw && !appointmentId) {
        return res.status(400).json({ error: 'appointmentId must be a valid UUID' });
      }
      if (appointmentId) {
        if (sessionUser.role === 'CAREGIVER') {
          const scope = await loadAppointmentScope(appointmentId);
          if (!scope || !canSessionAccessAppointment(sessionUser, scope)) {
            return res.status(403).json({ error: 'You are not allowed to view escalations for this appointment' });
          }
        }
        clauses.push(`appointment_id = $${params.length + 1}::uuid`);
        params.push(appointmentId);
      }

      const statusRaw = String(req.query.status || '').trim().toUpperCase();
      if (statusRaw) {
        if (!ESCALATION_STATUSES.has(statusRaw as EscalationStatus)) {
          return res.status(400).json({ error: `Invalid escalation status: ${statusRaw}` });
        }
        clauses.push(`status = $${params.length + 1}`);
        params.push(statusRaw);
      }

      const categoryRaw = String(req.query.category || '').trim().toUpperCase();
      if (categoryRaw) {
        if (!ESCALATION_CATEGORIES.has(categoryRaw as EscalationCategory)) {
          return res.status(400).json({ error: `Invalid escalation category: ${categoryRaw}` });
        }
        clauses.push(`category = $${params.length + 1}`);
        params.push(categoryRaw);
      }

      const beforeIso = String(req.query.before || '').trim();
      if (beforeIso) {
        clauses.push(`opened_at < $${params.length + 1}::timestamptz`);
        params.push(beforeIso);
      }

      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 100;
      params.push(limit);

      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(
        `
          SELECT
            id::text,
            caregiver_id::text,
            COALESCE(appointment_id::text, '') AS appointment_id,
            COALESCE(delegation_id, '') AS delegation_id,
            source,
            category,
            priority,
            status,
            summary,
            context_json,
            opened_by,
            COALESCE(resolved_by, '') AS resolved_by,
            COALESCE(resolution_type, '') AS resolution_type,
            opened_at::text,
            COALESCE(acknowledged_at::text, '') AS acknowledged_at,
            COALESCE(resolved_at::text, '') AS resolved_at,
            created_at::text,
            updated_at::text
          FROM escalations
          ${whereSql}
          ORDER BY opened_at DESC
          LIMIT $${params.length}::int
        `,
        params,
      );

      res.json({ data: result.rows.map((row) => mapEscalationRow(row)) });
    } catch (error) {
      console.error('Failed to list escalations', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /escalations
  // Creates a new escalation and posts a system notice in the scheduler thread.
  app.post('/escalations', async (req: Request, res: Response) => {
    try {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!['CAREGIVER', 'COORDINATOR'].includes(sessionUser.role)) {
        return res.status(403).json({ error: 'Only caregivers or coordinators can create escalations' });
      }

      const category = String(req.body.category || '').trim().toUpperCase();
      if (!ESCALATION_CATEGORIES.has(category as EscalationCategory)) {
        return res.status(400).json({ error: 'Valid escalation category is required' });
      }

      const summary = String(req.body.summary || '').trim();
      if (!summary) {
        return res.status(400).json({ error: 'summary is required' });
      }

      const sourceRaw = String(req.body.source || 'AGENT_DESK').trim().toUpperCase();
      const source = ESCALATION_SOURCES.has(sourceRaw as EscalationSource)
        ? (sourceRaw as EscalationSource)
        : 'AGENT_DESK';
      const contextJson = req.body.context && typeof req.body.context === 'object'
        ? (req.body.context as Record<string, unknown>)
        : {};
      const delegationId = String(req.body.delegationId || '').trim() || null;

      const appointmentIdRaw = String(req.body.appointmentId || '').trim();
      const appointmentId = appointmentIdRaw ? normalizeOptionalUuid(appointmentIdRaw) : undefined;
      if (appointmentIdRaw && !appointmentId) {
        return res.status(400).json({ error: 'appointmentId must be a valid UUID' });
      }

      let caregiverId = String(req.body.caregiverId || '').trim();
      let appointmentScope: AppointmentScopeRow | null = null;
      if (appointmentId) {
        appointmentScope = await loadAppointmentScope(appointmentId);
        if (!appointmentScope) {
          return res.status(404).json({ error: 'Appointment not found' });
        }
        if (!canSessionAccessAppointment(sessionUser, appointmentScope)) {
          return res.status(403).json({ error: 'You are not allowed to escalate for this appointment' });
        }
        if (!caregiverId) caregiverId = appointmentScope.caregiverId;
      }

      if (sessionUser.role === 'CAREGIVER') {
        caregiverId = sessionUser.userId;
      }
      if (!caregiverId) {
        return res.status(400).json({ error: 'caregiverId is required (or inferable from appointmentId)' });
      }
      if (appointmentScope && caregiverId !== appointmentScope.caregiverId) {
        return res.status(400).json({ error: 'caregiverId does not match appointment caregiver' });
      }

      const openedBy = sessionUser.role;
      const insertRes = await pool.query(
        `
          INSERT INTO escalations (
            caregiver_id,
            appointment_id,
            delegation_id,
            source,
            category,
            priority,
            status,
            summary,
            context_json,
            opened_by,
            opened_at,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2::uuid,
            $3,
            $4,
            $5,
            'HIGH',
            'OPEN',
            $6,
            $7::jsonb,
            $8,
            NOW(),
            NOW(),
            NOW()
          )
          RETURNING
            id::text,
            caregiver_id::text,
            COALESCE(appointment_id::text, '') AS appointment_id,
            COALESCE(delegation_id, '') AS delegation_id,
            source,
            category,
            priority,
            status,
            summary,
            context_json,
            opened_by,
            COALESCE(resolved_by, '') AS resolved_by,
            COALESCE(resolution_type, '') AS resolution_type,
            opened_at::text,
            COALESCE(acknowledged_at::text, '') AS acknowledged_at,
            COALESCE(resolved_at::text, '') AS resolved_at,
            created_at::text,
            updated_at::text
        `,
        [
          caregiverId,
          appointmentId || null,
          delegationId,
          source,
          category,
          summary,
          JSON.stringify(contextJson),
          openedBy,
        ],
      );
      const escalation = mapEscalationRow(insertRes.rows[0]);
      const schedulerMessage = await appendSchedulerThreadMessage({
        caregiverId,
        senderType: 'SYSTEM',
        content: `Escalation opened (${category}): ${summary}`,
        escalationId: escalation.id,
        metadata: {
          eventType: 'ESCALATION_OPENED',
          category,
          priority: 'HIGH',
          appointmentId: escalation.appointmentId || null,
        },
      });

      res.json({
        success: true,
        data: escalation,
        schedulerThread: {
          threadId: schedulerMessage.threadId,
          messageId: schedulerMessage.id,
        },
      });
    } catch (error) {
      console.error('Failed to create escalation', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // PATCH /escalations/:id
  // Updates escalation status and resolution metadata.
  app.patch('/escalations/:id', async (req: Request, res: Response) => {
    try {
      const escalationId = String(req.params.id || '').trim();
      const normalizedEscalationId = normalizeOptionalUuid(escalationId);
      if (!normalizedEscalationId) {
        return res.status(400).json({ error: 'id must be a valid UUID' });
      }

      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!['CAREGIVER', 'COORDINATOR'].includes(sessionUser.role)) {
        return res.status(403).json({ error: 'Only caregivers or coordinators can update escalations' });
      }

      const existingRes = await pool.query(
        `
          SELECT
            id::text,
            caregiver_id::text,
            status
          FROM escalations
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [normalizedEscalationId],
      );
      if (existingRes.rows.length === 0) {
        return res.status(404).json({ error: 'Escalation not found' });
      }

      const existing = existingRes.rows[0];
      const ownerCaregiverId = String(existing.caregiver_id || '').trim();
      const currentStatus = String(existing.status || '').trim().toUpperCase() as EscalationStatus;
      if (sessionUser.role === 'CAREGIVER' && sessionUser.userId !== ownerCaregiverId) {
        return res.status(403).json({ error: 'Caregivers can only update their own escalations' });
      }

      const nextStatusRaw = String(req.body.status || '').trim().toUpperCase();
      if (!ESCALATION_STATUSES.has(nextStatusRaw as EscalationStatus)) {
        return res.status(400).json({ error: 'Valid status is required' });
      }
      const nextStatus = nextStatusRaw as EscalationStatus;
      if (!canTransitionEscalationStatus(currentStatus, nextStatus)) {
        return res.status(409).json({ error: `Cannot transition escalation status from ${currentStatus} to ${nextStatus}` });
      }

      const resolutionTypeRaw = String(req.body.resolutionType || '').trim().toUpperCase();
      const resolutionType = resolutionTypeRaw
        ? (ESCALATION_RESOLUTION_TYPES.has(resolutionTypeRaw as EscalationResolutionType)
          ? resolutionTypeRaw
          : null)
        : null;
      if (resolutionTypeRaw && !resolutionType) {
        return res.status(400).json({ error: `Invalid resolutionType: ${resolutionTypeRaw}` });
      }
      const resolutionNote = String(req.body.resolutionNote || '').trim();
      const actor = `${sessionUser.role}:${sessionUser.userId}`;
      const markResolved = ['RESOLVED', 'HANDOFF_TO_CAREGIVER', 'AUTO_CLOSED'].includes(nextStatus);

      const updatedRes = await pool.query(
        `
          UPDATE escalations
          SET
            status = $2::text,
            resolution_type = COALESCE($3::text, resolution_type),
            resolved_by = CASE
              WHEN $4::boolean = true THEN $5::text
              ELSE resolved_by
            END,
            acknowledged_at = CASE
              WHEN $2::text = 'ACKNOWLEDGED'::text AND acknowledged_at IS NULL THEN NOW()
              ELSE acknowledged_at
            END,
            resolved_at = CASE
              WHEN $4::boolean = true THEN NOW()
              ELSE resolved_at
            END,
            context_json = CASE
              WHEN $6::text <> '' THEN COALESCE(context_json, '{}'::jsonb) || jsonb_build_object('resolutionNote', $6::text)
              ELSE context_json
            END,
            updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING
            id::text,
            caregiver_id::text,
            COALESCE(appointment_id::text, '') AS appointment_id,
            COALESCE(delegation_id, '') AS delegation_id,
            source,
            category,
            priority,
            status,
            summary,
            context_json,
            opened_by,
            COALESCE(resolved_by, '') AS resolved_by,
            COALESCE(resolution_type, '') AS resolution_type,
            opened_at::text,
            COALESCE(acknowledged_at::text, '') AS acknowledged_at,
            COALESCE(resolved_at::text, '') AS resolved_at,
            created_at::text,
            updated_at::text
        `,
        [
          normalizedEscalationId,
          nextStatus,
          resolutionType,
          markResolved,
          actor,
          resolutionNote,
        ],
      );
      const escalation = mapEscalationRow(updatedRes.rows[0]);
      const statusMessage = await appendSchedulerThreadMessage({
        caregiverId: ownerCaregiverId,
        senderType: 'SYSTEM',
        content: `Escalation ${escalation.id.slice(0, 8)} marked ${nextStatus} by ${sessionUser.displayName}.`,
        escalationId: escalation.id,
        metadata: {
          eventType: 'ESCALATION_STATUS_UPDATED',
          status: nextStatus,
          actor,
        },
      });

      res.json({
        success: true,
        data: escalation,
        schedulerThread: {
          threadId: statusMessage.threadId,
          messageId: statusMessage.id,
        },
      });
    } catch (error) {
      console.error('Failed to update escalation', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
      res.status(500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : errorMessage,
      });
    }
  });

  // GET /agents/:userId/status
  // Fetches the current status of a user's digital twin
  app.get('/agents/:userId/status', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
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
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
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
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
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

  // GET /agents/:userId/chat/history
  // Persistent Agent Desk thread history (newest-first pagination).
  app.get('/agents/:userId/chat/history', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }

      const limit = clampInteger(req.query.limit, 1, 200, 80);
      const before = String(req.query.before || '').trim();
      if (before && Number.isNaN(Date.parse(before))) {
        return res.status(400).json({ error: 'before must be a valid ISO timestamp' });
      }
      let rows = await listAgentDeskMessages({
        caregiverId: userId,
        limit,
        before: before || undefined,
      });
      if (rows.length === 0 || !shouldUseAgentDeskPersistence()) {
        const { settings } = await getAgentSettings(userId);
        const assistantState = getAssistantState(settings);
        const legacyRows = listLegacyAgentDeskMessagesFromAssistantHistory({
          caregiverId: userId,
          assistantHistory: assistantState.history,
          limit,
          before: before || undefined,
        });
        if (legacyRows.length > 0) {
          rows = legacyRows;
        }
      }
      const nextCursor = rows.length > 0 ? rows[rows.length - 1].createdAt : null;

      return res.json({
        success: true,
        data: rows,
        paging: {
          limit,
          nextCursor,
          hasMore: rows.length >= limit,
        },
      });
    } catch (error) {
      console.error('Failed to load agent desk chat history', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /agents/:userId/delegations/start
  // Deprecated: delegation start must go through /agents/:userId/command (confirmation-gated).
  app.post('/agents/:userId/delegations/start', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
      return res.status(410).json({
        error: 'Manual delegation start endpoint is deprecated. Use POST /agents/:userId/command to initiate delegation with contact confirmation.',
        code: 'DELEGATION_START_VIA_COMMAND_REQUIRED',
      });
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
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
      const rawCommand = String(req.body.command || req.body.text || '').trim();
      const requestedAppointmentId = String(req.body.appointmentId || '').trim();
      const normalizedRequestedAppointmentId = normalizeOptionalUuid(requestedAppointmentId);
      const forceStart = Boolean(req.body.forceStart);
      const requestedDuration = Number(req.body.durationMinutes);
      const toolTrace: AgentToolTraceEntry[] = [];
      let lastAssistantChatMessageId: string | undefined;
      const withToolTrace = <T extends Record<string, any>>(
        data: T,
      ): T & { toolTrace: AgentToolTraceEntry[]; chatMessageId?: string } => ({
        ...data,
        ...(lastAssistantChatMessageId ? { chatMessageId: lastAssistantChatMessageId } : {}),
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

      let { settings, role, version: settingsVersion } = await getAgentSettings(userId);
      let assistantState = appendAssistantTurn(getAssistantState(settings), 'CAREGIVER', rawCommand, {
        appointmentId: normalizedRequestedAppointmentId,
      });
      const effectiveRequestedAppointmentId =
        normalizedRequestedAppointmentId ||
        normalizeOptionalUuid(assistantState.pending?.requestedAppointmentId) ||
        normalizeOptionalUuid(assistantState.memory?.appointmentId);
      const commandTurn = assistantState.history[assistantState.history.length - 1];
      if (commandTurn) {
        try {
          await appendAgentDeskMessage({
            caregiverId: userId,
            actorType: 'CAREGIVER',
            appointmentId: commandTurn.appointmentId || effectiveRequestedAppointmentId,
            content: commandTurn.content,
            source: 'AGENT_COMMAND',
            metadata: {
              route: '/agents/:userId/command',
            },
            dedupeKey: buildAgentDeskTurnDedupeKey({
              caregiverId: userId,
              role: 'CAREGIVER',
              content: commandTurn.content,
              createdAt: commandTurn.createdAt,
            }),
            createdAt: commandTurn.createdAt,
          });
        } catch (error) {
          console.warn('[AGENT] Failed to persist caregiver command to agent desk history', {
            caregiverId: userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const persistAssistantState = async (options?: { source?: string; metadata?: Record<string, unknown> }) => {
        const toTurnKey = (turn: AssistantTurn): string => {
          const hash = crypto
            .createHash('sha1')
            .update(`${turn.role}|${turn.content}`)
            .digest('hex')
            .slice(0, 16);
          return `${turn.createdAt}|${turn.role}|${hash}`;
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const baseSettings = attempt === 0 ? settings : (await getAgentSettings(userId)).settings;
          const previousAssistant = getAssistantState(baseSettings);
          const previousTurnKeys = new Set(previousAssistant.history.map(toTurnKey));
          const candidateSettings = { ...baseSettings };
          candidateSettings.assistant = assistantState;
          const expectedVersion = attempt === 0 ? settingsVersion : getAgentSettingsVersion(candidateSettings);
          try {
            settingsVersion = await saveAgentSettings(userId, role || 'CAREGIVER', candidateSettings, {
              expectedVersion,
            });
            settings = candidateSettings;
            if (shouldUseAgentDeskPersistence()) {
              const persistedAssistantIds: string[] = [];
              try {
                for (const turn of assistantState.history) {
                  const turnKey = toTurnKey(turn);
                  if (previousTurnKeys.has(turnKey)) continue;
                  const actorType: AgentDeskActorType = turn.role === 'CAREGIVER' ? 'CAREGIVER' : 'ASSISTANT';
                  const messageId = await appendAgentDeskMessage({
                    caregiverId: userId,
                    actorType,
                    appointmentId: turn.appointmentId,
                    content: turn.content,
                    source: String(options?.source || 'AGENT_COMMAND'),
                    metadata: {
                      ...(options?.metadata || {}),
                      turnCreatedAt: turn.createdAt,
                    },
                    dedupeKey: buildAgentDeskTurnDedupeKey({
                      caregiverId: userId,
                      role: actorType,
                      content: turn.content,
                      createdAt: turn.createdAt,
                    }),
                    createdAt: turn.createdAt,
                  });
                  if (actorType === 'ASSISTANT' && messageId) {
                    persistedAssistantIds.push(messageId);
                  }
                }
              } catch (error) {
                console.warn('[AGENT] Failed to persist assistant state delta to agent desk history', {
                  caregiverId: userId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              if (persistedAssistantIds.length > 0) {
                lastAssistantChatMessageId = persistedAssistantIds[persistedAssistantIds.length - 1];
              }
            }
            return;
          } catch (error) {
            const isConflict = error instanceof SettingsVersionConflictError;
            if (!isConflict || attempt === 1) {
              throw error;
            }
          }
        }
      };
      const turnSignals = await analyzeCaregiverTurnWithLLM({
        command: rawCommand,
        assistantState,
      });

      if (!assistantState.pending && turnSignals.isGreeting) {
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

      if (!assistantState.pending && turnSignals.isAcknowledgement) {
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

      if (turnSignals.isCancellation && assistantState.pending) {
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

      const shouldMergePending = Boolean(
        assistantState.pending &&
          turnSignals.mergeWithPending &&
          !turnSignals.isCancellation,
      );
      const commandForPlanning = combineCommandWithPending(
        assistantState,
        rawCommand,
        shouldMergePending,
      );
      const pendingExecutionCommand = assistantState.pending
        ? combineCommandWithPending(assistantState, rawCommand, true)
        : commandForPlanning;
      const commandForToolExecution =
        assistantState.pending && (shouldMergePending || turnSignals.executePending)
          ? pendingExecutionCommand
          : commandForPlanning;
      if (shouldMergePending) {
        assistantState = pushPendingClarification(assistantState, rawCommand);
      }
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
      const referencedClientForTurn = resolveClientReferenceFromContext({
        command: rawCommand,
        appointments,
        requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        memory: assistantState.memory,
      });
      if (referencedClientForTurn) {
        assistantState = updateAssistantMemoryFromAppointment(
          assistantState,
          referencedClientForTurn,
          assistantState.memory?.businessDateHint,
        );
      }
      const llmContextResolution = await resolveAppointmentWithLLM({
        appointments,
        command: rawCommand,
        requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        memory: assistantState.memory,
      });
      const deterministicExplicitContextForTurn = hasExplicitAppointmentContext({
        command: rawCommand,
        appointments,
        requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
      });
      const explicitContextForTurn =
        llmContextResolution?.explicitContext ??
        deterministicExplicitContextForTurn;
      const commandForTargetResolution =
        assistantState.pending && (shouldMergePending || turnSignals.executePending)
          ? deterministicExplicitContextForTurn
            ? rawCommand
            : assistantState.pending.baseCommand
          : deterministicExplicitContextForTurn
            ? rawCommand
            : commandForToolExecution;

      let plannerDecision: AssistantPlannerDecision | null = null;
      const plannerStartMs = Date.now();
      const aiFirstIntentEnabled =
        shouldUseAiFirstIntent(config.assistant) && Boolean(config.openai.apiKey);
      if (aiFirstIntentEnabled) {
        try {
          plannerDecision = await planAssistantDecisionWithLLM({
            userId,
            command: commandForPlanning,
            assistantState,
            appointments,
            requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
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
      } else {
        plannerDecision = maybeDeterministicFallbackPlannerDecision({
          command: commandForPlanning,
          turnSignals,
          assistantState,
          appointments,
          requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        });
        if (plannerDecision) {
          recordToolTrace(toolTrace, {
            tool: 'assistant.plan_decision',
            source: 'deterministic_policy',
            startedAtMs: plannerStartMs,
            ok: true,
            message: 'Used deterministic planner path (AI-first disabled or no LLM key).',
          });
        }
      }

      if (!plannerDecision) {
        const deterministicFallback = maybeDeterministicFallbackPlannerDecision({
          command: commandForPlanning,
          turnSignals,
          assistantState,
          appointments,
          requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        });
        if (deterministicFallback) {
          plannerDecision = deterministicFallback;
          recordToolTrace(toolTrace, {
            tool: 'assistant.plan_decision',
            source: 'deterministic_fallback',
            startedAtMs: plannerStartMs,
            ok: true,
            message: aiFirstIntentEnabled
              ? 'LLM planner unavailable/empty; used deterministic fallback.'
              : 'Used deterministic fallback.',
          });
        }
      }

      if (!plannerDecision) {
        if (assistantState.pending && (shouldMergePending || turnSignals.executePending)) {
          plannerDecision = buildPendingToolDecision(assistantState, pendingExecutionCommand) || { action: 'RESPOND' };
        } else {
          plannerDecision = {
            action: 'RESPOND',
          };
        }
      }

      const pickTargetAppointment = async (commandForResolution: string): Promise<CaregiverAppointmentRow | null> => {
        const resolveStartMs = Date.now();
        const llmResolved = await resolveAppointmentWithLLM({
          appointments,
          command: commandForResolution,
          requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
          memory: assistantState.memory,
        });
        const target =
          llmResolved?.appointment ||
          (llmResolved?.explicitContext
            ? null
            : pickAppointmentForConversation({
                appointments,
                command: commandForResolution,
                requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
                memory: assistantState.memory,
              }));
        recordToolTrace(toolTrace, {
          tool: 'appointment.resolve_target',
          source: llmResolved ? 'openai_chat_completions+in_memory_fallback' : 'in_memory',
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
        (shouldMergePending || turnSignals.executePending)
      ) {
        plannerDecision = buildPendingToolDecision(assistantState, pendingExecutionCommand) || plannerDecision;
      }

      const allowLegacyPlannerRecovery = shouldUseLegacyPlannerRecovery(config.assistant);
      if (
        allowLegacyPlannerRecovery &&
        plannerDecision.action === 'RESPOND' &&
        !plannerDecision.tool &&
        !turnSignals.isCancellation
      ) {
        const recoverStartMs = Date.now();
        const recovered = await recoverToolDecisionWithLLM({
          command: commandForPlanning,
          assistantState,
          appointments,
          requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.recover_tool_decision',
          source: config.openai.apiKey ? 'openai_chat_completions' : 'disabled',
          startedAtMs: recoverStartMs,
          ok: Boolean(recovered),
        });
        if (recovered?.action === 'USE_TOOL' && recovered.tool) {
          plannerDecision = recovered;
        }
      } else if (
        !allowLegacyPlannerRecovery &&
        plannerDecision.action === 'RESPOND' &&
        !plannerDecision.tool &&
        !turnSignals.isCancellation
      ) {
        recordToolTrace(toolTrace, {
          tool: 'assistant.recover_tool_decision',
          source: 'disabled_by_single_router_policy',
          startedAtMs: Date.now(),
          ok: true,
          message: 'Skipped legacy recovery hop in single-router mode.',
        });
      }

      if (
        assistantState.pending &&
        !turnSignals.isCancellation &&
        turnSignals.executePending &&
        plannerDecision.action !== 'USE_TOOL'
      ) {
        plannerDecision = buildPendingToolDecision(assistantState, pendingExecutionCommand) || plannerDecision;
      }

      plannerDecision = applyRouterContractDefaults(plannerDecision);

      const shouldForceDelegation =
        !turnSignals.isCancellation &&
        hasDelegationIntent(commandForPlanning) &&
        hasExplicitDelegationDirective(commandForPlanning) &&
        !(plannerDecision.action === 'USE_TOOL' && plannerDecision.tool === 'START_DELEGATION');
      if (shouldForceDelegation) {
        plannerDecision = {
          action: 'USE_TOOL',
          tool: 'START_DELEGATION',
          objective: String(commandForPlanning || rawCommand).trim(),
        };
        recordToolTrace(toolTrace, {
          tool: 'assistant.delegation_safety_override',
          source: 'deterministic_safety',
          startedAtMs: Date.now(),
          ok: true,
          message: 'Forced START_DELEGATION due to explicit caregiver outreach directive.',
        });
      }

      const shouldForceClientInfo =
        plannerDecision.action === 'RESPOND' &&
        !turnSignals.isCancellation &&
        shouldForceClientInfoFromContext({
          command: commandForPlanning,
          assistantState,
          appointments,
          requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
        });
      if (shouldForceClientInfo) {
        plannerDecision = {
          action: 'USE_TOOL',
          tool: 'CLIENT_INFO',
          infoQuestion: String(commandForPlanning || rawCommand).trim(),
        };
        recordToolTrace(toolTrace, {
          tool: 'assistant.client_info_safety_override',
          source: 'deterministic_safety',
          startedAtMs: Date.now(),
          ok: true,
          message: 'Forced CLIENT_INFO for client fact query with resolvable client context.',
        });
      }

      const requiresDelegationContactConfirmation =
        plannerDecision.action === 'USE_TOOL' &&
        plannerDecision.tool === 'START_DELEGATION' &&
        !turnSignals.isCancellation &&
        !(
          assistantState.pending?.kind === 'DELEGATION_CONTACT_CONFIRM' &&
          turnSignals.executePending
        );
      if (requiresDelegationContactConfirmation) {
        const confirmationPrompt =
          'I can contact the client/family to find out the missing details. Do you want me to reach out now? Reply yes to proceed or cancel to stop.';
        assistantState = setAssistantPending(assistantState, {
          kind: 'DELEGATION_CONTACT_CONFIRM',
          tool: 'START_DELEGATION',
          baseCommand: commandForToolExecution,
          requestedAppointmentId: effectiveRequestedAppointmentId,
        });
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', confirmationPrompt);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'FOLLOW_UP',
            response: confirmationPrompt,
          }),
        });
      }

      if (
        plannerDecision.action === 'ASK_FOLLOW_UP' &&
        assistantState.pending &&
        (shouldMergePending || turnSignals.executePending)
      ) {
        plannerDecision = buildPendingToolDecision(assistantState, pendingExecutionCommand) || plannerDecision;
      }

      if (plannerDecision.action === 'ASK_FOLLOW_UP') {
        const followUpTool = inferToolForFollowUp(plannerDecision, assistantState, commandForPlanning);
        if (!followUpTool && !assistantState.pending) {
          plannerDecision = {
            action: 'RESPOND',
            response:
              plannerDecision.response ||
              'I can answer directly when possible, and for tool-driven tasks I will ask only the minimum needed detail.',
          };
        } else if (followUpTool === 'MAPS_ROUTE') {
          plannerDecision = {
            action: 'USE_TOOL',
            tool: 'MAPS_ROUTE',
            homeAddress: plannerDecision.homeAddress,
            appointmentHint: plannerDecision.appointmentHint,
          };
        } else if (followUpTool === 'CLIENT_INFO' || followUpTool === 'START_DELEGATION') {
          const resolutionCommand = `${commandForPlanning} ${plannerDecision.appointmentHint || ''}`.trim();
          const inferredTarget = await pickTargetAppointment(resolutionCommand);
          if (inferredTarget) {
            plannerDecision = {
              action: 'USE_TOOL',
              tool: followUpTool,
              appointmentHint: plannerDecision.appointmentHint,
              infoQuestion:
                followUpTool === 'CLIENT_INFO'
                  ? String(plannerDecision.infoQuestion || commandForPlanning).trim()
                  : undefined,
              objective:
                followUpTool === 'START_DELEGATION'
                  ? String(plannerDecision.objective || commandForPlanning).trim()
                  : undefined,
              questions:
                followUpTool === 'START_DELEGATION' && Array.isArray(plannerDecision.questions)
                  ? plannerDecision.questions
                  : undefined,
            };
          }
        }
      }

      plannerDecision = applyRouterContractDefaults(plannerDecision);

      if (plannerDecision.action === 'ASK_FOLLOW_UP') {
        const followUpTool = inferToolForFollowUp(plannerDecision, assistantState, commandForPlanning);
        const followUpText =
          plannerDecision.followUpQuestion ||
          buildFollowUpQuestionFromRequiredSlots(plannerDecision.requiredSlots, followUpTool) ||
          'Can you clarify which visit or details you want me to use before I proceed?';
        const repeatedFollowUp = isRepeatedAssistantPrompt(assistantState.history, followUpText);
        if (repeatedFollowUp) {
          const directReplyStartMs = Date.now();
          const directReply = await generateAssistantDirectResponseWithLLM({
            command: rawCommand,
            assistantState,
            appointments,
            plannerHint:
              'Avoid repeating the same follow-up. Give one concise best-effort answer with limits and a single next step.',
          });
          recordToolTrace(toolTrace, {
            tool: 'assistant.respond_freeform',
            source: config.openai.apiKey ? 'openai_chat_completions' : 'disabled',
            startedAtMs: directReplyStartMs,
            ok: true,
          });
          const responseText = await sanitizeNonToolAssistantResponse({
            response:
              directReply ||
              'I cannot proceed with that tool from the details so far. Give the missing detail in one message, or ask me to handle another task.',
            command: rawCommand,
            assistantState,
            appointments,
            settings,
            appointmentIdHint: effectiveRequestedAppointmentId || assistantState.memory?.appointmentId,
          });
          assistantState = clearAssistantPending(assistantState);
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

        const pendingBase = assistantState.pending?.baseCommand || rawCommand;
        if (followUpTool === 'MAPS_ROUTE' || assistantState.pending?.kind === 'MAPS_HOME_ADDRESS') {
          assistantState = setAssistantPending(assistantState, {
            kind: 'MAPS_HOME_ADDRESS',
            tool: 'MAPS_ROUTE',
            baseCommand: pendingBase,
            requestedAppointmentId: effectiveRequestedAppointmentId,
          });
        } else if (followUpTool === 'CLIENT_INFO' || assistantState.pending?.kind === 'CLIENT_INFO_CONTEXT') {
          assistantState = setAssistantPending(assistantState, {
            kind: 'CLIENT_INFO_CONTEXT',
            tool: 'CLIENT_INFO',
            baseCommand: pendingBase,
            requestedAppointmentId: effectiveRequestedAppointmentId,
          });
        } else if (
          followUpTool === 'START_DELEGATION' ||
          assistantState.pending?.kind === 'DELEGATION_CONTEXT' ||
          assistantState.pending?.kind === 'DELEGATION_TARGET_CONTEXT'
        ) {
          assistantState = setAssistantPending(assistantState, {
            kind:
              assistantState.pending?.kind === 'DELEGATION_TARGET_CONTEXT'
                ? 'DELEGATION_TARGET_CONTEXT'
                : 'DELEGATION_CONTEXT',
            tool: 'START_DELEGATION',
            baseCommand: pendingBase,
            requestedAppointmentId: effectiveRequestedAppointmentId,
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
        const plannerHint = [
          plannerDecision.response,
          plannerDecision.responseStyle === 'STEP_BY_STEP'
            ? 'Use a short numbered step-by-step response.'
            : 'Keep the response concise and direct.',
        ]
          .filter((line): line is string => Boolean(line && String(line).trim()))
          .join('\n');
        const directReply = await generateAssistantDirectResponseWithLLM({
          command: rawCommand,
          assistantState,
          appointments,
          plannerHint,
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.respond_freeform',
          source: config.openai.apiKey ? 'openai_chat_completions' : 'disabled',
          startedAtMs: directReplyStartMs,
          ok: true,
        });

        const rawResponseText =
          directReply ||
          plannerDecision.response ||
          'I can help with your schedule, routes, client context, and delegation workflows. What should I handle first?';
        const responseText = await sanitizeNonToolAssistantResponse({
          response: rawResponseText,
          command: rawCommand,
          assistantState,
          appointments,
          settings,
          appointmentIdHint: effectiveRequestedAppointmentId || assistantState.memory?.appointmentId,
        });
        const missingInfoPolicyStartMs = Date.now();
        const missingInfoDecision = await evaluateMissingInfoPolicy({
          command: rawCommand,
          answerDraft: responseText,
          source: 'RESPOND',
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.missing_info_policy',
          source: config.openai.apiKey ? 'openai_chat_completions+deterministic_fallback' : 'deterministic_policy',
          startedAtMs: missingInfoPolicyStartMs,
          ok: true,
          message: `${missingInfoDecision.action} (${missingInfoDecision.rationale})`,
        });
        const hasActiveDelegationForResponseContext = hasRelevantActiveDelegation({
          settings,
          appointmentId: effectiveRequestedAppointmentId || assistantState.memory?.appointmentId,
        });
        const shouldAskDelegationConfirmation =
          missingInfoDecision.action === 'ACQUIRE_MISSING_INFO' &&
          missingInfoDecision.confidence >= 0.55 &&
          !hasActiveDelegationForResponseContext &&
          assistantState.pending?.kind !== 'DELEGATION_CONTACT_CONFIRM' &&
          !turnSignals.isCancellation;
        if (shouldAskDelegationConfirmation) {
          const confirmationPrompt = buildDelegationContactConfirmationPrompt(responseText);
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_CONTACT_CONFIRM',
            tool: 'START_DELEGATION',
            baseCommand: commandForToolExecution,
            requestedAppointmentId: effectiveRequestedAppointmentId,
          });
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', confirmationPrompt);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'FOLLOW_UP',
              response: confirmationPrompt,
            }),
          });
        }
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
        const businessDate = resolveRequestedBusinessDate(commandForToolExecution, assistantState.memory?.businessDateHint);
        const scheduleStartMs = Date.now();
        const dayAppointments = await loadCaregiverAppointments(userId, { businessDate });
        recordToolTrace(toolTrace, {
          tool: 'schedule.get_day',
          source: 'postgres',
          startedAtMs: scheduleStartMs,
          ok: true,
        });

        const responseText = buildScheduleOverviewResponse(dayAppointments, businessDate);
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
            schedule: dayAppointments,
          }),
        });
      }

      if (plannerDecision.tool === 'MAPS_ROUTE') {
        const mapsStartMs = Date.now();
        try {
          const baseCommand = commandForToolExecution;
          const businessDate = resolveRequestedBusinessDate(baseCommand, assistantState.memory?.businessDateHint);
          const plan = await buildMapsDayPlan({
            userId,
            command: baseCommand,
            businessDate,
            requestedAppointmentId: effectiveRequestedAppointmentId || undefined,
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
              requestedAppointmentId: effectiveRequestedAppointmentId,
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
            businessDate,
          );
          const disclosureResponse = appendInferredContextDisclosure(plan.response, {
            inferred: !explicitContextForTurn,
            appointment: targetAppointmentFromResolved(plan.resolvedAppointment || null, appointments),
          });
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', disclosureResponse);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'ANSWERED',
              response: disclosureResponse,
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
        const infoQuestion = String(plannerDecision.infoQuestion || commandForToolExecution);
        const targetCommand = `${commandForTargetResolution} ${plannerDecision.appointmentHint || ''}`.trim();
        const targetAppointment = await pickTargetAppointment(targetCommand);
        if (!targetAppointment) {
          const followUp =
            'Which client or visit should I check? You can mention the client name or select a visit first.';
          assistantState = setAssistantPending(assistantState, {
            kind: 'CLIENT_INFO_CONTEXT',
            tool: 'CLIENT_INFO',
            baseCommand: infoQuestion,
            requestedAppointmentId: effectiveRequestedAppointmentId,
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
          specificAppointmentId: effectiveRequestedAppointmentId || undefined,
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

        const hasActiveDelegationForTarget = hasRelevantActiveDelegation({
          settings,
          appointmentId: targetAppointment.appointmentId,
        });
        const disclosedAnswer = enforceDelegationStateClaims({
          response: appendInferredContextDisclosure(synthesized, {
            inferred: !explicitContextForTurn,
            appointment: targetAppointment,
          }),
          hasRelevantActiveDelegation: hasActiveDelegationForTarget,
        });
        const missingInfoPolicyStartMs = Date.now();
        const missingInfoDecision = await evaluateMissingInfoPolicy({
          command: infoQuestion || rawCommand,
          answerDraft: disclosedAnswer,
          source: 'CLIENT_INFO',
        });
        recordToolTrace(toolTrace, {
          tool: 'assistant.missing_info_policy',
          source: config.openai.apiKey ? 'openai_chat_completions+deterministic_fallback' : 'deterministic_policy',
          startedAtMs: missingInfoPolicyStartMs,
          ok: true,
          message: `${missingInfoDecision.action} (${missingInfoDecision.rationale})`,
        });
        const shouldAskDelegationConfirmation =
          missingInfoDecision.action === 'ACQUIRE_MISSING_INFO' &&
          missingInfoDecision.confidence >= 0.55 &&
          !hasActiveDelegationForTarget &&
          assistantState.pending?.kind !== 'DELEGATION_CONTACT_CONFIRM' &&
          !turnSignals.isCancellation;
        if (shouldAskDelegationConfirmation) {
          assistantState = clearAssistantPending(assistantState);
          assistantState = updateAssistantMemoryFromAppointment(assistantState, targetAppointment, businessDateHint);
          const confirmationPrompt = buildDelegationContactConfirmationPrompt(disclosedAnswer);
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_CONTACT_CONFIRM',
            tool: 'START_DELEGATION',
            baseCommand: infoQuestion || commandForToolExecution,
            requestedAppointmentId: targetAppointment.appointmentId,
          });
          assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', confirmationPrompt);
          await persistAssistantState();
          return res.json({
            success: true,
            data: withToolTrace({
              mode: 'FOLLOW_UP',
              response: confirmationPrompt,
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

        assistantState = clearAssistantPending(assistantState);
        assistantState = updateAssistantMemoryFromAppointment(assistantState, targetAppointment, businessDateHint);
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', disclosedAnswer);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'ANSWERED',
            response: disclosedAnswer,
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
        const pendingForDelegation = assistantState.pending;
        const confirmedDelegationContinuation =
          pendingForDelegation?.kind === 'DELEGATION_CONTACT_CONFIRM' &&
          turnSignals.executePending;
        const delegationCommand =
          confirmedDelegationContinuation && pendingForDelegation
            ? pendingForDelegation.baseCommand
            : commandForToolExecution;
        if (
          assistantState.pending?.kind === 'DELEGATION_TARGET_CONTEXT' &&
          !deterministicExplicitContextForTurn
        ) {
          const followUp =
            'Which visit should I delegate? Please give the client name or choose the target appointment.';
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_TARGET_CONTEXT',
            tool: 'START_DELEGATION',
            baseCommand: delegationCommand,
            requestedAppointmentId: effectiveRequestedAppointmentId,
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
        const targetCommand = `${commandForTargetResolution} ${plannerDecision.appointmentHint || ''}`.trim();
        const targetAppointment = await pickTargetAppointment(targetCommand);
        if (!targetAppointment) {
          const followUp =
            'Which visit should I delegate? Please give the client name or choose the target appointment.';
          assistantState = setAssistantPending(assistantState, {
            kind: 'DELEGATION_TARGET_CONTEXT',
            tool: 'START_DELEGATION',
            baseCommand: delegationCommand,
            requestedAppointmentId: effectiveRequestedAppointmentId,
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

        const compilerStartMs = Date.now();
        const compilerHistory = await loadDelegationCompilerHistory(userId, assistantState.history);
        const compiledContext = config.assistant.delegationContextCompilerV1
          ? await compileDelegationContext({
              command: delegationCommand,
              history: compilerHistory,
              resolvedAppointment: {
                appointmentId: targetAppointment.appointmentId,
                clientName: targetAppointment.clientName,
                appointmentStartTime: targetAppointment.startTime,
              },
              openaiApiKey: config.openai.apiKey,
              model: config.openai.model,
              maxQuestions: 5,
            })
          : null;
        recordToolTrace(toolTrace, {
          tool: 'delegation.compile_context',
          source: config.assistant.delegationContextCompilerV1
            ? config.openai.apiKey
              ? 'openai_chat_completions+deterministic_validation'
              : 'deterministic_fallback'
            : 'disabled_by_feature_flag',
          startedAtMs: compilerStartMs,
          ok: true,
        });

        const derived = deriveDelegationPlan(delegationCommand);
        const plannerObjective = confirmedDelegationContinuation
          ? ''
          : String(plannerDecision.objective || '').trim();
        const delegationObjective = compiledContext?.objective || plannerObjective || derived.objective;
        const plannerQuestions = Array.isArray(plannerDecision.questions)
          ? plannerDecision.questions.map((q) => String(q || '').trim()).filter(Boolean)
          : [];
        const plannerQuestionItems: DelegationQuestionItem[] = plannerQuestions.map((text) => ({
          text,
          priority: 'PRIMARY',
        }));
        const delegationQuestions =
          (compiledContext?.questions && compiledContext.questions.length > 0
            ? compiledContext.questions
            : plannerQuestions.length > 0
              ? plannerQuestions
              : derived.questions
          ).slice(0, 5);
        const delegationQuestionItems: DelegationQuestionItem[] =
          compiledContext?.questionItems && compiledContext.questionItems.length > 0
            ? compiledContext.questionItems
            : plannerQuestionItems.length > 0
              ? plannerQuestionItems
              : delegationQuestions.map((text) => ({ text, priority: 'PRIMARY' as const }));
        const delegationType: DelegationType =
          compiledContext?.delegationType || inferDelegationTypeFromCommand(delegationCommand);
        const contextPacket: DelegationContextPacket = compiledContext?.contextPacket || {
          objective: delegationObjective,
          knownFacts: [],
          missingFacts: ['Collect unresolved caregiver-requested details from client/family.'],
          evidence: compilerHistory.slice(-6).map((line) => `[${line.role}] ${line.content}`),
          model: config.assistant.delegationContextCompilerV1 ? 'deterministic_fallback' : 'feature_flag_disabled',
          generatedAt: new Date().toISOString(),
          delegationType,
          primaryQuestionCount: delegationQuestionItems.filter((q) => q.priority === 'PRIMARY').length,
          optionalQuestionCount: delegationQuestionItems.filter((q) => q.priority === 'OPTIONAL').length,
        };

        const delegationStartMs = Date.now();
        const startResult = await startDelegationWindow({
          userId,
          appointmentId: targetAppointment.appointmentId,
          objective: delegationObjective,
          durationMinutes: Number.isFinite(requestedDuration) ? requestedDuration : 30,
          questions: delegationQuestions,
          questionItems: delegationQuestionItems,
          delegationType,
          forceStart,
          contextPacket,
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

        const kickoffAskedIndexes = Array.isArray(startResult.delegation.askedQuestionIndexes)
          ? startResult.delegation.askedQuestionIndexes
              .map((idx) => Number(idx))
              .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < startResult.delegation.questions.length)
          : [];
        const kickoffQuestionLine =
          kickoffAskedIndexes.length > 1
            ? `Initial questions sent: ${kickoffAskedIndexes.map((idx) => startResult.delegation.questions[idx]).join(' | ')}`
            : startResult.firstQuestion
              ? `First question sent: ${startResult.firstQuestion}`
              : 'A kickoff update was sent to the client.';
        const appendedQuestionCount = Number(startResult.appendedQuestionCount || 0);
        const newlyAskedQuestions = Array.isArray(startResult.newlyAskedQuestions)
          ? startResult.newlyAskedQuestions.filter(Boolean)
          : [];
        const responseText = startResult.reusedExisting
          ? appendedQuestionCount > 0
            ? [
                `Added ${appendedQuestionCount} follow-up question${appendedQuestionCount === 1 ? '' : 's'} to the active delegation for ${targetAppointment.clientName}.`,
                `Current window: ${formatBusinessDateTime(startResult.delegation.startedAt)} to ${formatBusinessDateTime(startResult.delegation.endsAt)}.`,
                newlyAskedQuestions.length > 0
                  ? `Asked now: ${newlyAskedQuestions.join(' | ')}`
                  : 'New questions were added and will continue within this same delegation window.',
              ].join(' ')
            : [
                `Delegation is already active for ${targetAppointment.clientName}.`,
                `Current window: ${formatBusinessDateTime(startResult.delegation.startedAt)} to ${formatBusinessDateTime(startResult.delegation.endsAt)}.`,
                'No new unique questions were added.',
              ].join(' ')
          : [
              `Started delegation for ${targetAppointment.clientName}.`,
              `Window: ${formatBusinessDateTime(startResult.delegation.startedAt)} to ${formatBusinessDateTime(startResult.delegation.endsAt)}.`,
              kickoffQuestionLine,
            ].join(' ');
        const disclosedResponseText = appendInferredContextDisclosure(responseText, {
          inferred: !explicitContextForTurn,
          appointment: targetAppointment,
        });
        assistantState = clearAssistantPending(assistantState);
        assistantState = updateAssistantMemoryFromAppointment(assistantState, targetAppointment, parseBusinessDateHint(targetCommand));
        assistantState = appendAssistantTurn(assistantState, 'ASSISTANT', disclosedResponseText);
        await persistAssistantState();
        return res.json({
          success: true,
          data: withToolTrace({
            mode: 'DELEGATION_STARTED',
            response: disclosedResponseText,
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
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
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
      const wasSystemManagedPrecheck = isSystemManagedDelegationEntry(delegation);
      const summary = await buildDelegationSummary(appointmentId, delegation.startedAt, endedAt, {
        objective: delegation.objective,
        questions: delegation.questions || [],
      });
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

      if (!wasSystemManagedPrecheck) {
        try {
          await maybeResumePrecheckAfterManualCompletion({
            appointmentId,
            caregiverId: userId,
            manualDelegationStartedAt: delegation.startedAt,
            manualDelegationEndedAt: endedAt,
          });
        } catch (error) {
          console.error('Failed to evaluate post-manual precheck recovery', {
            appointmentId,
            caregiverId: userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

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
      if (!authorizeAgentUserAccess(req, res, userId)) {
        return;
      }
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
