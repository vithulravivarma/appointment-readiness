export type ForcedQuestionInput = {
  delegationActive: boolean;
  delegationIsSystemManaged: boolean;
  delegatedNextQuestion: string | null;
  checklistNextQuestion: string | null;
};

export function isSystemManagedDelegationEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const cast = entry as Record<string, unknown>;
  if (Boolean(cast.systemManaged)) return true;
  const source = String(cast.source || '').trim().toUpperCase();
  return source === 'PRECHECK_AUTOMATION';
}

export function pickForcedQuestion(input: ForcedQuestionInput): string | null {
  const { delegationActive, delegationIsSystemManaged, delegatedNextQuestion, checklistNextQuestion } = input;
  const prioritizeDelegationQuestion = delegationActive && !delegationIsSystemManaged;
  if (prioritizeDelegationQuestion) {
    return delegatedNextQuestion || checklistNextQuestion || null;
  }
  return checklistNextQuestion || delegatedNextQuestion || null;
}

export function shouldWritePrecheckSummaryToDelegation(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return true;
  const cast = entry as Record<string, unknown>;
  return isSystemManagedDelegationEntry(cast);
}
