import {
  evaluateDelegationCompletion,
  formatDelegationCompletionUpdate,
  formatDelegationProgressUpdate,
} from './delegation-completion-policy';

describe('delegation-completion-policy', () => {
  test('marks completion only when all askable questions resolved', () => {
    const result = evaluateDelegationCompletion({
      questions: ['Q1?', 'Q2?'],
      askableIndexes: [0, 1],
      requiredIndexes: [0, 1],
      existingResolvedIndexes: [0],
      answeredIndexes: [1],
      delegationActive: true,
      delegationIsSystemManaged: false,
      completionAlreadyNotified: false,
      notifyFlagEnabled: true,
    });

    expect(result.resolvedIndexes).toEqual([0, 1]);
    expect(result.unresolvedIndexes).toEqual([]);
    expect(result.unresolvedRequiredIndexes).toEqual([]);
    expect(result.shouldNotifyCompletion).toBe(true);
  });

  test('does not mark completion when unresolved askable question remains', () => {
    const result = evaluateDelegationCompletion({
      questions: ['Q1?', 'Q2?'],
      askableIndexes: [0, 1],
      requiredIndexes: [0, 1],
      existingResolvedIndexes: [0],
      answeredIndexes: [],
      delegationActive: true,
      delegationIsSystemManaged: false,
      completionAlreadyNotified: false,
      notifyFlagEnabled: true,
    });

    expect(result.resolvedIndexes).toEqual([0]);
    expect(result.unresolvedIndexes).toEqual([1]);
    expect(result.unresolvedRequiredIndexes).toEqual([1]);
    expect(result.shouldNotifyCompletion).toBe(false);
  });

  test('completion notify is idempotent when already notified', () => {
    const result = evaluateDelegationCompletion({
      questions: ['Q1?'],
      askableIndexes: [0],
      requiredIndexes: [0],
      existingResolvedIndexes: [0],
      answeredIndexes: [0],
      delegationActive: true,
      delegationIsSystemManaged: false,
      completionAlreadyNotified: true,
      notifyFlagEnabled: true,
    });

    expect(result.shouldNotifyCompletion).toBe(false);
  });

  test('completes when required questions are resolved even if optional askable remains', () => {
    const result = evaluateDelegationCompletion({
      questions: ['Primary?', 'Optional?'],
      askableIndexes: [0, 1],
      requiredIndexes: [0],
      existingResolvedIndexes: [0],
      answeredIndexes: [],
      delegationActive: true,
      delegationIsSystemManaged: false,
      completionAlreadyNotified: false,
      notifyFlagEnabled: true,
    });

    expect(result.unresolvedIndexes).toEqual([1]);
    expect(result.unresolvedRequiredIndexes).toEqual([]);
    expect(result.shouldNotifyCompletion).toBe(true);
  });

  test('formats concise completion message', () => {
    const message = formatDelegationCompletionUpdate({
      clientName: 'Yashwanth',
      questions: ['Does he have Advil?', 'Is dog at home?'],
      resolvedIndexes: [0, 1],
      unresolvedRequiredIndexes: [],
      latestClientMessage: 'He has Advil in the cabinet by the microwave.',
    });

    expect(message).toContain('Delegation update for Yashwanth');
    expect(message).toContain('Resolved: Does he have Advil? | Is dog at home?');
    expect(message).toContain('Latest client update');
  });

  test('formats progress update with newly resolved facts', () => {
    const message = formatDelegationProgressUpdate({
      clientName: 'Yashwanth',
      questions: ['Does he have Advil?', 'If yes, where is it located in the home?'],
      newlyResolvedIndexes: [0],
      unresolvedRequiredIndexes: [1],
      latestClientMessage: 'yeah he does',
    });

    expect(message).toContain('Delegation progress for Yashwanth');
    expect(message).toContain('Resolved now: Does he have Advil?');
    expect(message).toContain('Still needed: If yes, where is it located in the home?');
  });
});
