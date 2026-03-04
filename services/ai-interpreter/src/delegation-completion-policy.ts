export type DelegationCompletionEvaluation = {
  resolvedIndexes: number[];
  unresolvedIndexes: number[];
  requiredResolvedIndexes: number[];
  unresolvedRequiredIndexes: number[];
  shouldNotifyCompletion: boolean;
};

function normalizeIndexList(values: unknown, questionCount: number): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < questionCount)
    .filter((value, idx, arr) => arr.indexOf(value) === idx)
    .sort((a, b) => a - b);
}

export function evaluateDelegationCompletion(input: {
  questions: string[];
  askableIndexes: number[];
  requiredIndexes?: number[];
  existingResolvedIndexes?: unknown;
  answeredIndexes: number[];
  delegationActive: boolean;
  delegationIsSystemManaged: boolean;
  completionAlreadyNotified: boolean;
  notifyFlagEnabled: boolean;
}): DelegationCompletionEvaluation {
  const questionCount = input.questions.length;
  const existingResolved = normalizeIndexList(input.existingResolvedIndexes, questionCount);
  const askable = normalizeIndexList(input.askableIndexes, questionCount);
  const required = normalizeIndexList(
    Array.isArray(input.requiredIndexes) && input.requiredIndexes.length > 0
      ? input.requiredIndexes
      : askable,
    questionCount,
  );
  const answered = normalizeIndexList(input.answeredIndexes, questionCount);

  const resolvedSet = new Set<number>(existingResolved);
  for (const idx of answered) {
    resolvedSet.add(idx);
  }

  const resolvedIndexes = Array.from(resolvedSet).sort((a, b) => a - b);
  const unresolvedIndexes = askable.filter((idx) => !resolvedSet.has(idx));
  const requiredSet = new Set<number>(required);
  const requiredAskable = askable.filter((idx) => requiredSet.has(idx));
  const requiredUniverse = requiredAskable.length > 0 ? requiredAskable : required;
  const requiredResolvedIndexes = requiredUniverse.filter((idx) => resolvedSet.has(idx));
  const unresolvedRequiredIndexes = requiredUniverse.filter((idx) => !resolvedSet.has(idx));
  const shouldNotifyCompletion =
    input.notifyFlagEnabled &&
    input.delegationActive &&
    !input.delegationIsSystemManaged &&
    !input.completionAlreadyNotified &&
    requiredUniverse.length > 0 &&
    unresolvedRequiredIndexes.length === 0;

  return {
    resolvedIndexes,
    unresolvedIndexes,
    requiredResolvedIndexes,
    unresolvedRequiredIndexes,
    shouldNotifyCompletion,
  };
}

function compact(value: string, limit = 240): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1))}...`;
}

export function formatDelegationProgressUpdate(input: {
  clientName: string;
  questions: string[];
  newlyResolvedIndexes: number[];
  unresolvedRequiredIndexes: number[];
  latestClientMessage?: string;
}): string {
  const clientName = String(input.clientName || 'client');
  const resolvedNow = input.newlyResolvedIndexes
    .map((idx) => String(input.questions[idx] || '').trim())
    .filter(Boolean);
  const unresolvedRequired = input.unresolvedRequiredIndexes
    .map((idx) => String(input.questions[idx] || '').trim())
    .filter(Boolean);

  const headline = `Delegation progress for ${clientName}: resolved ${resolvedNow.length} requested item(s), ${unresolvedRequired.length} primary item(s) still open.`;
  const latest = compact(String(input.latestClientMessage || ''), 220);
  const lines = [headline, `Resolved now: ${resolvedNow.join(' | ') || 'None'}`];
  if (unresolvedRequired.length > 0) {
    lines.push(`Still needed: ${unresolvedRequired.join(' | ')}`);
  }
  if (latest) {
    lines.push(`Latest client update: "${latest}"`);
  }
  return lines.join('\n');
}

export function formatDelegationCompletionUpdate(input: {
  clientName: string;
  questions: string[];
  resolvedIndexes: number[];
  unresolvedRequiredIndexes: number[];
  latestClientMessage?: string;
}): string {
  const clientName = String(input.clientName || 'client');
  const resolved = input.resolvedIndexes
    .map((idx) => String(input.questions[idx] || '').trim())
    .filter(Boolean);
  const unresolved = input.unresolvedRequiredIndexes
    .map((idx) => String(input.questions[idx] || '').trim())
    .filter(Boolean);

  const line1 = unresolved.length === 0
    ? `Delegation update for ${clientName}: I now have answers for all requested questions.`
    : `Delegation update for ${clientName}: resolved ${resolved.length} requested item(s), still missing ${unresolved.length}.`;

  if (unresolved.length === 0) {
    const latest = compact(String(input.latestClientMessage || ''), 220);
    return latest
      ? `${line1}\nResolved: ${resolved.join(' | ')}\nLatest client update: "${latest}"`
      : `${line1}\nResolved: ${resolved.join(' | ')}`;
  }

  const latest = compact(String(input.latestClientMessage || ''), 220);
  return latest
    ? `${line1}\nResolved: ${resolved.join(' | ')}\nStill missing: ${unresolved.join(' | ')}\nLatest client update: "${latest}"`
    : `${line1}\nResolved: ${resolved.join(' | ')}\nStill missing: ${unresolved.join(' | ')}`;
}
