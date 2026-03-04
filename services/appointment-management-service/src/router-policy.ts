export type RouterPolicyConfig = {
  singleRouterV1: boolean;
  enableLegacyRecoveryV0: boolean;
  aiFirstIntentV1: boolean;
};

export function shouldUsePlannerRepairHop(config: RouterPolicyConfig): boolean {
  // In single-router mode, we avoid a second LLM pass to repair malformed planner output.
  return !config.singleRouterV1;
}

export function shouldUseLegacyPlannerRecovery(config: RouterPolicyConfig): boolean {
  // Legacy recovery is opt-in and only available when single-router mode is disabled.
  return !config.singleRouterV1 && config.enableLegacyRecoveryV0;
}

export function shouldUseAiFirstIntent(config: RouterPolicyConfig): boolean {
  return config.aiFirstIntentV1;
}
