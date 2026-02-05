import { evaluateReadiness, EvaluationResult } from './logic';
import { ReadinessState } from './repository';

describe('Readiness Logic (The Brain)', () => {
  
  const baseState: ReadinessState = {
    appointmentId: 'test-1',
    status: 'NOT_STARTED',
    riskScore: 0,
    checks: []
  };

  test('should return NOT_STARTED if checklist is empty', () => {
    const result = evaluateReadiness({ ...baseState, checks: [] });
    expect(result.nextStatus).toBe('NOT_STARTED');
    expect(result.shouldNotify).toBe(false);
  });

  test('should escalate to BLOCKED if ANY check fails', () => {
    const state = {
      ...baseState,
      checks: [
        { type: 'MEDS', status: 'PASS' },
        { type: 'ACCESS', status: 'FAIL' } // <--- CRITICAL FAILURE
      ]
    };
    
    const result = evaluateReadiness(state);
    expect(result.nextStatus).toBe('BLOCKED');
    expect(result.riskScore).toBe(100);
    expect(result.shouldNotify).toBe(true);
  });

  test('should mark READY only when ALL checks pass', () => {
    const state = {
      ...baseState,
      checks: [
        { type: 'MEDS', status: 'PASS' },
        { type: 'ACCESS', status: 'PASS' }
      ]
    };

    const result = evaluateReadiness(state);
    expect(result.nextStatus).toBe('READY');
    expect(result.shouldNotify).toBe(true);
  });

  test('should remain IN_PROGRESS if checks are mixed pending/pass', () => {
    const state = {
      ...baseState,
      checks: [
        { type: 'MEDS', status: 'PASS' },
        { type: 'ACCESS', status: 'PENDING' }
      ]
    };

    const result = evaluateReadiness(state);
    expect(result.nextStatus).toBe('IN_PROGRESS');
  });
});