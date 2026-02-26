import { ReadinessState } from './repository';
import { CHECKLIST_DEFINITIONS } from './repository';

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
  const pendingChecks = state.checks.filter(c => c.status === 'PENDING').length;

  const criticalSet = new Set(CHECKLIST_DEFINITIONS.filter((c) => c.critical).map((c) => c.key));
  const criticalFailed = state.checks.some((c) => criticalSet.has(String(c.type)) && c.status === 'FAIL');
  const criticalPending = state.checks.filter((c) => criticalSet.has(String(c.type)) && c.status === 'PENDING').length;

  // RULE 1: Any critical failure -> BLOCKED
  if (criticalFailed) {
    return { 
      nextStatus: 'BLOCKED', 
      riskScore: 100, 
      shouldNotify: true // Escalation needed!
    };
  }

  // RULE 1b: Non-critical failures still keep appointment at risk
  if (failedChecks > 0) {
    return {
      nextStatus: 'AT_RISK',
      riskScore: 75,
      shouldNotify: true,
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
  if (criticalPending > 0) {
    return {
      nextStatus: 'IN_PROGRESS',
      riskScore: 60,
      shouldNotify: false,
    };
  }

  return { 
    nextStatus: 'IN_PROGRESS', 
    riskScore: pendingChecks > 0 ? 40 : 25,
    shouldNotify: false 
  };
}
