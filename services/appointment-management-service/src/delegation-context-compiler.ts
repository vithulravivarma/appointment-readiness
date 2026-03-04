import crypto from 'crypto';

export type DelegationType = 'FACT_CHECK' | 'LOGISTICS' | 'OPEN_ENDED';
export type DelegationQuestionPriority = 'PRIMARY' | 'OPTIONAL';
export type DelegationQuestionItem = {
  text: string;
  priority: DelegationQuestionPriority;
};

export type DelegationContextPacket = {
  objective: string;
  knownFacts: string[];
  missingFacts: string[];
  evidence: string[];
  model: string;
  generatedAt: string;
  delegationType?: DelegationType;
  primaryQuestionCount?: number;
  optionalQuestionCount?: number;
};

export type DelegationContextCompileResult = {
  objective: string;
  questions: string[];
  questionItems: DelegationQuestionItem[];
  delegationType: DelegationType;
  contextPacket: DelegationContextPacket;
};

export type DelegationContextHistoryLine = {
  role: 'CAREGIVER' | 'ASSISTANT';
  content: string;
  createdAt?: string;
};

export type DelegationContextEvidenceLine = {
  senderType: string;
  content: string;
  createdAt?: string;
};

export type DelegationContextResolvedAppointment = {
  appointmentId: string;
  clientName: string;
  appointmentStartTime?: string;
};

export type CompileDelegationContextInput = {
  command: string;
  history: DelegationContextHistoryLine[];
  resolvedAppointment?: DelegationContextResolvedAppointment | null;
  knownEvidence?: DelegationContextEvidenceLine[];
  openaiApiKey?: string;
  model: string;
  maxQuestions?: number;
};

function compact(value: string, limit = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1))}...`;
}

function cleanQuestion(value: string): string {
  const text = compact(value, 180)
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const withQ = /[?]$/.test(text) ? text : `${text}?`;
  return withQ.length <= 180 ? withQ : `${withQ.slice(0, 177)}...`;
}

function normalizeDelegationType(value: unknown): DelegationType | null {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'FACT_CHECK' || normalized === 'LOGISTICS' || normalized === 'OPEN_ENDED') {
    return normalized as DelegationType;
  }
  return null;
}

export function inferDelegationTypeFromCommand(command: string): DelegationType {
  const normalized = String(command || '').toLowerCase();
  if (!normalized.trim()) return 'OPEN_ENDED';

  const explicitOpenEnded = /\b(any updates|anything else|other updates|general update|logistics update)\b/.test(normalized);
  if (explicitOpenEnded) return 'OPEN_ENDED';

  const factStyle =
    /\b(does|is|are|has|have|whether|if)\b/.test(normalized) &&
    /\b(home|house|fridge|refrigerator|advil|ibuprofen|tylenol|med|medicine|dog|pet|code|access|gate)\b/.test(normalized);
  const locationStyle = /\b(where|location|located|in the house|at home)\b/.test(normalized);
  if (factStyle || locationStyle) return 'FACT_CHECK';

  const logisticsStyle = /\b(access|arrival|parking|gate|code|supplies|ready|before the visit|visit logistics)\b/.test(normalized);
  if (logisticsStyle) return 'LOGISTICS';

  return 'OPEN_ENDED';
}

function normalizeFactList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const fact = compact(String(item || ''), 180);
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeQuestionItems(input: {
  rawQuestionItems: unknown;
  rawQuestions: unknown;
  maxQuestions: number;
  delegationType: DelegationType;
}): DelegationQuestionItem[] {
  const merged: DelegationQuestionItem[] = [];
  const pushItem = (textRaw: unknown, priorityRaw: unknown) => {
    const text = cleanQuestion(String(textRaw || ''));
    if (!text) return;
    const priority = String(priorityRaw || '').trim().toUpperCase() === 'OPTIONAL' ? 'OPTIONAL' : 'PRIMARY';
    merged.push({ text, priority });
  };

  if (Array.isArray(input.rawQuestionItems)) {
    for (const row of input.rawQuestionItems) {
      if (!row || typeof row !== 'object') continue;
      const item = row as Record<string, unknown>;
      pushItem(item.text ?? item.question, item.priority);
    }
  }

  if (Array.isArray(input.rawQuestions)) {
    for (const row of input.rawQuestions) {
      pushItem(row, 'PRIMARY');
    }
  }

  const byText = new Map<string, DelegationQuestionItem>();
  for (const item of merged) {
    if (!looksClientAskable(item.text)) continue;
    const key = item.text.toLowerCase();
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, item);
      continue;
    }
    if (existing.priority === 'OPTIONAL' && item.priority === 'PRIMARY') {
      byText.set(key, item);
    }
  }

  const deduped = Array.from(byText.values());
  const totalLimit = Math.max(1, Math.min(8, input.maxQuestions));
  const budgetByType: Record<DelegationType, { primary: number; optional: number; total: number }> = {
    FACT_CHECK: { primary: 2, optional: 0, total: Math.min(2, totalLimit) },
    LOGISTICS: { primary: Math.min(3, totalLimit), optional: Math.min(1, totalLimit), total: Math.min(4, totalLimit) },
    OPEN_ENDED: {
      primary: Math.min(3, totalLimit),
      optional: Math.max(0, totalLimit - Math.min(3, totalLimit)),
      total: totalLimit,
    },
  };
  const budget = budgetByType[input.delegationType];
  const primary = deduped.filter((q) => q.priority === 'PRIMARY').slice(0, budget.primary);
  const optional = deduped.filter((q) => q.priority === 'OPTIONAL').slice(0, budget.optional);
  const limited = [...primary, ...optional].slice(0, budget.total);

  if (limited.length === 0) return [];
  if (!limited.some((q) => q.priority === 'PRIMARY')) {
    limited[0] = { ...limited[0], priority: 'PRIMARY' };
  }
  return limited;
}

function looksClientAskable(question: string): boolean {
  const normalized = String(question || '').toLowerCase();
  if (!normalized) return false;
  if (/\b(caregiver|care team|provider|coordinator|internal|billing|insurance|authorize)\b/.test(normalized)) {
    return false;
  }
  return true;
}

function buildFallbackObjective(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) return 'Collect the requested missing details from the client or family.';
  return compact(trimmed, 220);
}

function buildFallbackQuestion(command: string): string {
  const trimmed = compact(command, 140);
  if (!trimmed) return 'Can you help confirm the missing details needed before the visit?';
  return cleanQuestion(`Can you help confirm this request: ${trimmed}`);
}

function buildFallbackQuestionItems(input: CompileDelegationContextInput, delegationType: DelegationType): DelegationQuestionItem[] {
  const command = String(input.command || '');
  const normalized = command.toLowerCase();
  const clientName = String(input.resolvedAppointment?.clientName || 'the client').trim();
  const medMatch = normalized.match(/\b(advil|ibuprofen|tylenol|acetaminophen)\b/);
  const medName = medMatch?.[1] ? medMatch[1].toUpperCase() : '';
  const hasWhere = /\b(where|location|located|in the house|at home)\b/.test(normalized);

  if (delegationType === 'FACT_CHECK') {
    const q1 = medName
      ? cleanQuestion(`Does ${clientName} have ${medName} at home?`)
      : buildFallbackQuestion(command);
    const q2 = hasWhere || medName ? cleanQuestion('If yes, where is it located in the home?') : '';
    return [
      { text: q1, priority: 'PRIMARY' },
      ...(q2 ? [{ text: q2, priority: 'PRIMARY' as const }] : []),
    ];
  }

  return [{ text: buildFallbackQuestion(command), priority: 'PRIMARY' }];
}

function normalizeEvidenceLines(input: CompileDelegationContextInput): string[] {
  const historyLines = input.history
    .slice(-12)
    .map((line) => `[${line.role}] ${compact(line.content, 200)}`)
    .filter((line) => line.length > 0);

  const knownEvidence = (input.knownEvidence || [])
    .slice(-8)
    .map((line) => `[${String(line.senderType || 'UNKNOWN').toUpperCase()}] ${compact(line.content, 200)}`)
    .filter((line) => line.length > 0);

  const merged = [...historyLines, ...knownEvidence];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of merged) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 16) break;
  }
  return out;
}

function buildFallbackResult(input: CompileDelegationContextInput): DelegationContextCompileResult {
  const generatedAt = new Date().toISOString();
  const objective = buildFallbackObjective(input.command);
  const delegationType = inferDelegationTypeFromCommand(input.command);
  const fallbackItems = buildFallbackQuestionItems(input, delegationType);
  const questionItems = normalizeQuestionItems({
    rawQuestionItems: fallbackItems,
    rawQuestions: [],
    maxQuestions: Number.isFinite(Number(input.maxQuestions))
      ? Math.max(1, Math.min(8, Math.trunc(Number(input.maxQuestions))))
      : 5,
    delegationType,
  });
  const finalItems =
    questionItems.length > 0
      ? questionItems
      : [{ text: buildFallbackQuestion(input.command), priority: 'PRIMARY' as const }];
  const questions = finalItems.map((item) => item.text);
  const primaryQuestionCount = finalItems.filter((item) => item.priority === 'PRIMARY').length;
  const optionalQuestionCount = Math.max(0, finalItems.length - primaryQuestionCount);
  const knownFacts = normalizeFactList(
    (input.knownEvidence || []).slice(-4).map((row) => `${String(row.senderType || 'UNKNOWN')}: ${compact(row.content, 120)}`),
    4,
  );
  const missingFacts = [compact('Confirm unanswered details requested by caregiver.', 120)];
  const evidence = normalizeEvidenceLines(input).slice(-8);

  return {
    objective,
    questions,
    questionItems: finalItems,
    delegationType,
    contextPacket: {
      objective,
      knownFacts,
      missingFacts,
      evidence,
      model: input.openaiApiKey ? input.model : 'deterministic_fallback',
      generatedAt,
      delegationType,
      primaryQuestionCount,
      optionalQuestionCount,
    },
  };
}

function safeParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export async function compileDelegationContext(input: CompileDelegationContextInput): Promise<DelegationContextCompileResult> {
  const maxQuestions = Number.isFinite(Number(input.maxQuestions))
    ? Math.max(1, Math.min(8, Math.trunc(Number(input.maxQuestions))))
    : 5;
  const generatedAt = new Date().toISOString();
  const evidenceLines = normalizeEvidenceLines(input);

  if (!input.openaiApiKey) {
    return buildFallbackResult(input);
  }

  const promptEvidence = evidenceLines.length > 0 ? evidenceLines.join('\n') : '(none)';
  const appointmentSummary = input.resolvedAppointment
    ? `appointmentId=${input.resolvedAppointment.appointmentId}, client=${input.resolvedAppointment.clientName}, start=${
        input.resolvedAppointment.appointmentStartTime || 'unknown'
      }`
    : 'none';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Return JSON only.

You are compiling a delegation context packet for a caregiver assistant.
Output concise, client-answerable questions that directly target missing facts.
Do not ask generic "any updates" style questions when specific missing facts exist.
Avoid internal care-team/process questions.

Return schema:
{
  "delegationType": "FACT_CHECK|LOGISTICS|OPEN_ENDED",
  "objective": "string",
  "questionItems": [{ "text": "string", "priority": "PRIMARY|OPTIONAL" }],
  "questions": ["string"],
  "knownFacts": ["string"],
  "missingFacts": ["string"],
  "evidence": ["string"]
}

Constraints:
- FACT_CHECK: keep to max 2 PRIMARY questions and 0 OPTIONAL by default.
- Max ${maxQuestions} total questions.
- Keep each question short and specific.
- Preserve concrete known facts when available.
- Missing facts should map to the caregiver request.
- If context is weak, still produce at least 1 concrete question inferred from caregiver request.`,
          },
          {
            role: 'user',
            content: [
              `Latest caregiver request: ${compact(input.command, 500)}`,
              `Resolved appointment context: ${appointmentSummary}`,
              `Known evidence lines:\n${promptEvidence}`,
            ].join('\n\n'),
          },
        ],
      }),
    });

    if (!response.ok) {
      return buildFallbackResult(input);
    }

    const payload = (await response.json()) as any;
    const raw = String(payload?.choices?.[0]?.message?.content || '').trim();
    const parsed = safeParseJsonObject(raw);
    if (!parsed) {
      return buildFallbackResult(input);
    }

    const delegationType =
      normalizeDelegationType(parsed.delegationType) || inferDelegationTypeFromCommand(input.command);
    const objective = compact(String(parsed.objective || ''), 220) || buildFallbackObjective(input.command);
    const normalizedItems = normalizeQuestionItems({
      rawQuestionItems: parsed.questionItems,
      rawQuestions: parsed.questions,
      maxQuestions,
      delegationType,
    });
    const fallbackItems = buildFallbackQuestionItems(input, delegationType);
    const safeFinalItems =
      normalizedItems.length > 0
        ? normalizedItems
        : fallbackItems.length > 0
          ? fallbackItems
          : [{ text: buildFallbackQuestion(input.command), priority: 'PRIMARY' as const }];
    const questions = safeFinalItems.map((item) => item.text);
    const primaryQuestionCount = safeFinalItems.filter((item) => item.priority === 'PRIMARY').length;
    const optionalQuestionCount = Math.max(0, safeFinalItems.length - primaryQuestionCount);
    const knownFacts = normalizeFactList(parsed.knownFacts, 8);
    const missingFacts = normalizeFactList(parsed.missingFacts, 8);
    const evidence = normalizeFactList(parsed.evidence, 12);

    const packet: DelegationContextPacket = {
      objective,
      knownFacts,
      missingFacts,
      evidence: evidence.length > 0 ? evidence : evidenceLines.slice(-8),
      model: input.model,
      generatedAt,
      delegationType,
      primaryQuestionCount,
      optionalQuestionCount,
    };

    return {
      objective,
      questions,
      questionItems: safeFinalItems,
      delegationType,
      contextPacket: packet,
    };
  } catch {
    return buildFallbackResult(input);
  }
}

export function buildAgentDeskTurnDedupeKey(input: {
  caregiverId: string;
  role: 'CAREGIVER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  createdAt: string;
}): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${input.role}|${input.content}`)
    .digest('hex')
    .slice(0, 16);
  return `desk-turn:${input.caregiverId}:${input.createdAt}:${input.role}:${hash}`;
}
