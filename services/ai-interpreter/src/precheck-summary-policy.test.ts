import { buildPrecheckCompletionSummary, type PrecheckPlannerStateLike } from './precheck-summary-policy';

describe('precheck-summary-policy', () => {
  test('returns concise ready summary when all checks pass', () => {
    const planner: PrecheckPlannerStateLike = {
      items: {
        ACCESS_CONFIRMED: { status: 'PASS', evidence: 'Door code confirmed with family.' },
        MEDS_SUPPLIES_READY: { status: 'PASS' },
        CARE_PLAN_CURRENT: { status: 'PASS' },
      },
    };

    const summary = buildPrecheckCompletionSummary(planner);
    expect(summary).toContain('Precheck complete: Ready for visit.');
    expect(summary).toContain('Caregiver action: No blocker detected.');
  });

  test('highlights blockers and action when checks fail', () => {
    const planner: PrecheckPlannerStateLike = {
      items: {
        ACCESS_CONFIRMED: { status: 'FAIL', evidence: 'Family says gate code no longer works.' },
        MEDS_SUPPLIES_READY: { status: 'PASS' },
        CARE_PLAN_CURRENT: { status: 'FAIL', evidence: 'Care plan may be outdated.' },
      },
    };

    const summary = buildPrecheckCompletionSummary(planner);
    expect(summary).toContain('Caregiver follow-up required');
    expect(summary).toContain('Open blockers: Access details confirmed; Care instructions current.');
    expect(summary).toContain('gate code no longer works');
    expect(summary).toContain('Resolve open blockers before visit start');
  });
});
