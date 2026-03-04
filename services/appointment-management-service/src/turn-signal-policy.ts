export type CaregiverTurnSignals = {
  isGreeting: boolean;
  isAcknowledgement: boolean;
  isCancellation: boolean;
  mergeWithPending: boolean;
  executePending: boolean;
};

export type CaregiverTurnSignalResult = {
  signals: CaregiverTurnSignals;
  confident: boolean;
  reason: string;
};

const DEFAULT_SIGNALS: CaregiverTurnSignals = {
  isGreeting: false,
  isAcknowledgement: false,
  isCancellation: false,
  mergeWithPending: false,
  executePending: false,
};

const TURN_SIGNAL_POLICY = {
  cancellationPhrases: ['cancel', 'nevermind', 'never mind', 'stop that', 'stop this', 'forget it', 'scratch that', 'ignore that'],
  executePendingPhrases: ['yes', 'yep', 'yeah', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'proceed', 'run it', 'send it', 'start it', 'confirm', 'confirmed'],
  actionIntentTerms: ['schedule', 'visit', 'route', 'map', 'history', 'delegate', 'delegation', 'contact', 'ask', 'client', 'family', 'appointment', 'check'],
} as const;

function normalize(text: string): string {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWordBoundaryRegex(terms: readonly string[]): RegExp {
  return new RegExp(`\\b(${terms.map((term) => escapeRegExp(term)).join('|')})\\b`);
}

function buildStartsWithPhraseRegex(phrases: readonly string[]): RegExp {
  return new RegExp(`^(${phrases.map((phrase) => escapeRegExp(phrase)).join('|')})(?:\\b|[!.,\\s]|$)`);
}

function buildContainsPhraseRegex(phrases: readonly string[]): RegExp {
  return new RegExp(`\\b(${phrases.map((phrase) => escapeRegExp(phrase)).join('|')})\\b`);
}

const CANCELLATION_REGEX = buildContainsPhraseRegex(TURN_SIGNAL_POLICY.cancellationPhrases);
const EXECUTE_PENDING_REGEX = buildStartsWithPhraseRegex(TURN_SIGNAL_POLICY.executePendingPhrases);
const ACTION_INTENT_REGEX = buildWordBoundaryRegex(TURN_SIGNAL_POLICY.actionIntentTerms);

export function detectDeterministicTurnSignals(input: {
  command: string;
  hasPending: boolean;
}): CaregiverTurnSignalResult {
  const normalized = normalize(input.command);
  if (!normalized) {
    return {
      signals: { ...DEFAULT_SIGNALS },
      confident: false,
      reason: 'empty_command',
    };
  }

  const words = wordCount(normalized);
  const hasQuestion = normalized.includes('?');

  const isCancellation = CANCELLATION_REGEX.test(normalized);
  const hasActionIntent = ACTION_INTENT_REGEX.test(normalized);
  const isLikelyAmbiguousExecute = hasQuestion || (hasActionIntent && words > 4);

  const executePending =
    input.hasPending &&
    !isCancellation &&
    !isLikelyAmbiguousExecute &&
    EXECUTE_PENDING_REGEX.test(normalized);

  const signals: CaregiverTurnSignals = {
    isGreeting: false,
    isAcknowledgement: false,
    isCancellation,
    mergeWithPending: false,
    executePending,
  };

  const confident = Object.values(signals).some(Boolean);
  const reason = isCancellation
    ? 'cancel'
    : executePending
    ? 'execute_pending'
    : 'none';

  return {
    signals,
    confident,
    reason,
  };
}
