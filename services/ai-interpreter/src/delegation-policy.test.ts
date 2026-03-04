import {
  isSystemManagedDelegationEntry,
  pickForcedQuestion,
  shouldWritePrecheckSummaryToDelegation,
} from './delegation-policy';

describe('delegation-policy', () => {
  test('detects system-managed delegation by explicit flag', () => {
    expect(isSystemManagedDelegationEntry({ systemManaged: true })).toBe(true);
  });

  test('detects system-managed delegation by source', () => {
    expect(isSystemManagedDelegationEntry({ source: 'PRECHECK_AUTOMATION' })).toBe(true);
    expect(isSystemManagedDelegationEntry({ source: 'precheck_automation' })).toBe(true);
  });

  test('manual delegation is not treated as system-managed', () => {
    expect(isSystemManagedDelegationEntry({ source: 'MANUAL', systemManaged: false })).toBe(false);
    expect(isSystemManagedDelegationEntry(null)).toBe(false);
  });

  test('prioritizes manual delegation question when active', () => {
    const forced = pickForcedQuestion({
      delegationActive: true,
      delegationIsSystemManaged: false,
      delegatedNextQuestion: 'Did the family mention gate access updates?',
      checklistNextQuestion: 'Has access changed since last visit?',
    });
    expect(forced).toBe('Did the family mention gate access updates?');
  });

  test('prioritizes checklist question for system-managed delegation', () => {
    const forced = pickForcedQuestion({
      delegationActive: true,
      delegationIsSystemManaged: true,
      delegatedNextQuestion: 'Manual follow-up question',
      checklistNextQuestion: 'Has access changed since last visit?',
    });
    expect(forced).toBe('Has access changed since last visit?');
  });

  test('allows precheck summary write only for no entry or system-managed entry', () => {
    expect(shouldWritePrecheckSummaryToDelegation(null)).toBe(true);
    expect(shouldWritePrecheckSummaryToDelegation({ source: 'PRECHECK_AUTOMATION' })).toBe(true);
    expect(shouldWritePrecheckSummaryToDelegation({ source: 'MANUAL' })).toBe(false);
  });
});
