import { ReadinessState } from './repository';

export interface EvaluationResult {
  nextStatus: string;
  riskScore: number;
  shouldNotify: boolean;
}

/**
 * PURE LOGIC: Takes current state, decides next state.
 * This is the core "State Machine".
 */
export function evaluateReadiness(state: ReadinessState): EvaluationResult {
  const totalChecks = state.checks.length;
  if (totalChecks === 0) {
    // Edge case: No checks defined yet
    return { nextStatus: 'NOT_STARTED', riskScore: 0, shouldNotify: false };
  }

  const passedChecks = state.checks.filter(c => c.status === 'PASS').length;
  const failedChecks = state.checks.filter(c => c.status === 'FAIL').length;

  // RULE 1: Any Failure -> BLOCKED
  if (failedChecks > 0) {
    return { 
      nextStatus: 'BLOCKED', 
      riskScore: 100, 
      shouldNotify: true // Escalation needed!
    };
  }

  // RULE 2: All Passed -> READY
  if (passedChecks === totalChecks) {
    return { 
      nextStatus: 'READY', 
      riskScore: 0, 
      shouldNotify: true // Tell the caregiver "You are good to go"
    };
  }

  // RULE 3: Some PENDING -> IN_PROGRESS or AT_RISK
  // (Simple logic for now: Default to IN_PROGRESS)
  return { 
    nextStatus: 'IN_PROGRESS', 
    riskScore: 50, 
    shouldNotify: false 
  };
}