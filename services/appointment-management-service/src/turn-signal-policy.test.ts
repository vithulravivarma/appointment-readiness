import { detectDeterministicTurnSignals } from './turn-signal-policy';

describe('turn-signal-policy', () => {
  test('detects cancellation intent', () => {
    const result = detectDeterministicTurnSignals({ command: 'Never mind, cancel that', hasPending: true });
    expect(result.confident).toBe(true);
    expect(result.signals.isCancellation).toBe(true);
    expect(result.signals.executePending).toBe(false);
  });

  test('detects execute-pending confirmation', () => {
    const result = detectDeterministicTurnSignals({ command: 'Yes, do it', hasPending: true });
    expect(result.confident).toBe(true);
    expect(result.signals.executePending).toBe(true);
  });

  test('does not execute pending without pending state', () => {
    const result = detectDeterministicTurnSignals({ command: 'Yes, do it', hasPending: false });
    expect(result.confident).toBe(false);
    expect(result.signals.executePending).toBe(false);
  });

  test('non-control turns are non-confident and fall through', () => {
    const result = detectDeterministicTurnSignals({ command: 'Hi there', hasPending: false });
    expect(result.confident).toBe(false);
    expect(result.signals.isGreeting).toBe(false);
    expect(result.signals.isAcknowledgement).toBe(false);
    expect(result.signals.mergeWithPending).toBe(false);
  });

  test('ambiguous execute phrase with explicit action intent is not forced', () => {
    const result = detectDeterministicTurnSignals({ command: 'Yes, show me the schedule', hasPending: true });
    expect(result.confident).toBe(false);
    expect(result.signals.executePending).toBe(false);
  });
});
