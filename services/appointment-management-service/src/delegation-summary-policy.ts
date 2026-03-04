export type DelegationSummaryMessage = {
  senderType: string;
  content: string;
  createdAt?: string;
};

export type BuildCaregiverDelegationSummaryInput = {
  startedAtLabel: string;
  endedAtLabel: string;
  objective: string;
  requestedQuestions: string[];
  messages: DelegationSummaryMessage[];
  llmKeyPoints?: string[];
};

type SenderType = 'AI_AGENT' | 'FAMILY' | 'COORDINATOR' | 'SYSTEM' | 'OTHER';

type QAPair = {
  answer: string;
  responder: 'FAMILY' | 'COORDINATOR';
};

function normalizeSender(value: string): SenderType {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'AI_AGENT') return 'AI_AGENT';
  if (normalized === 'FAMILY') return 'FAMILY';
  if (normalized === 'COORDINATOR') return 'COORDINATOR';
  if (normalized === 'SYSTEM') return 'SYSTEM';
  return 'OTHER';
}

function compactSnippet(text: string, maxLength: number): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function normalizeKey(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSpeakerPrefix(text: string): string {
  return String(text || '')
    .replace(/^\s*\[[^\]]+\]\s*/g, '')
    .replace(/^\s*(family|coordinator|ai|assistant|system)\s*:\s*/i, '')
    .trim();
}

function isAckOnly(text: string): boolean {
  const normalized = normalizeKey(text);
  if (!normalized) return true;
  return /^(ok|okay|got it|thanks|thank you|sounds good|will do|yes|no|done)$/.test(normalized);
}

function sanitizePoint(text: string, maxLength: number): string {
  const stripped = stripSpeakerPrefix(String(text || ''));
  return compactSnippet(stripped, maxLength);
}

function dedupePoints(points: string[], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of points) {
    const point = sanitizePoint(raw, 180);
    if (!point || isAckOnly(point)) continue;
    const key = normalizeKey(point);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(point);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractQAPairs(messages: DelegationSummaryMessage[]): QAPair[] {
  const pairs: QAPair[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (normalizeSender(message.senderType) !== 'AI_AGENT') continue;

    if (!sanitizePoint(message.content, 140)) continue;

    for (let j = i + 1; j < messages.length && j <= i + 4; j += 1) {
      const candidate = messages[j];
      const sender = normalizeSender(candidate.senderType);
      if (sender === 'SYSTEM') continue;
      if (sender === 'AI_AGENT') break;
      if (sender !== 'FAMILY' && sender !== 'COORDINATOR') break;

      const answer = sanitizePoint(candidate.content, 180);
      if (!answer || isAckOnly(answer)) break;
      pairs.push({ answer, responder: sender });
      break;
    }
  }
  return pairs;
}

function humanizeUpdatePoint(point: string): string {
  let text = sanitizePoint(point, 180)
    .replace(/^\s*(family|coordinator)\s*:\s*/i, '')
    .replace(/^\s*(yeah|yep|yup)\b[\s,:-]*/i, '')
    .replace(/^\s*nope\b[\s,:-]*/i, 'No ')
    .trim();

  if (!text) return '';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) {
    text = `${text}.`;
  }
  return text;
}

export function buildCaregiverDelegationSummary(input: BuildCaregiverDelegationSummaryInput): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const normalizedMessages = messages
    .map((message) => ({
      senderType: normalizeSender(message.senderType),
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content.length > 0);

  const qaPairs = extractQAPairs(
    normalizedMessages.map((message) => ({
      senderType: message.senderType,
      content: message.content,
    })),
  );

  const llmPoints = Array.isArray(input.llmKeyPoints)
    ? input.llmKeyPoints.map((point) => sanitizePoint(String(point || ''), 180)).filter(Boolean)
    : [];

  const qaPoints = qaPairs.map((pair) =>
    `${pair.responder === 'FAMILY' ? 'Family' : 'Coordinator'} confirmed ${pair.answer}`,
  );

  const recentParticipantPoints = normalizedMessages
    .filter((message) => message.senderType === 'FAMILY' || message.senderType === 'COORDINATOR')
    .slice(-4)
    .map((message) => sanitizePoint(message.content, 180));

  const updates = dedupePoints([...llmPoints, ...qaPoints, ...recentParticipantPoints], 5)
    .map(humanizeUpdatePoint)
    .filter(Boolean);

  const objective = String(input.objective || '').trim() || 'Collect logistics updates and keep client informed.';

  return [
    `Delegation objective: ${objective}`,
    updates.length > 0
      ? `Key updates for caregiver:\n- ${updates.join('\n- ')}`
      : 'Key updates for caregiver:\n- No new logistics updates were confirmed yet.',
  ].join('\n');
}
