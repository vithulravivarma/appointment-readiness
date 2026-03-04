import { shouldUseAiFirstIntent, shouldUseLegacyPlannerRecovery, shouldUsePlannerRepairHop } from './router-policy';

describe('router-policy', () => {
  test('single-router mode disables planner repair hop', () => {
    expect(shouldUsePlannerRepairHop({ singleRouterV1: true, enableLegacyRecoveryV0: true, aiFirstIntentV1: true })).toBe(false);
  });

  test('legacy mode enables planner repair hop', () => {
    expect(shouldUsePlannerRepairHop({ singleRouterV1: false, enableLegacyRecoveryV0: false, aiFirstIntentV1: true })).toBe(true);
  });

  test('single-router mode disables legacy recovery even if env flag is enabled', () => {
    expect(shouldUseLegacyPlannerRecovery({ singleRouterV1: true, enableLegacyRecoveryV0: true, aiFirstIntentV1: true })).toBe(false);
  });

  test('legacy recovery requires both legacy mode and recovery flag', () => {
    expect(shouldUseLegacyPlannerRecovery({ singleRouterV1: false, enableLegacyRecoveryV0: true, aiFirstIntentV1: true })).toBe(true);
    expect(shouldUseLegacyPlannerRecovery({ singleRouterV1: false, enableLegacyRecoveryV0: false, aiFirstIntentV1: true })).toBe(false);
  });

  test('ai-first intent policy is controlled by feature flag', () => {
    expect(shouldUseAiFirstIntent({ singleRouterV1: true, enableLegacyRecoveryV0: false, aiFirstIntentV1: true })).toBe(true);
    expect(shouldUseAiFirstIntent({ singleRouterV1: true, enableLegacyRecoveryV0: false, aiFirstIntentV1: false })).toBe(false);
  });
});
