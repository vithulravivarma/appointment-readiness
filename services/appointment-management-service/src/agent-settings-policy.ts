export type AgentSettingsMeta = {
  version?: number;
};

export type AgentSettingsLike = {
  _meta?: AgentSettingsMeta;
  [key: string]: unknown;
};

export function getAgentSettingsVersion(settings: AgentSettingsLike | null | undefined): number {
  const rawVersion = Number((settings as any)?._meta?.version ?? 0);
  if (!Number.isFinite(rawVersion)) return 0;
  return Math.max(0, Math.trunc(rawVersion));
}

export function withAgentSettingsVersion<T extends AgentSettingsLike>(
  settings: T,
  nextVersion: number,
): T {
  const safeNextVersion = Math.max(0, Math.trunc(nextVersion));
  const base = (settings && typeof settings === 'object') ? settings : ({} as T);
  const meta = ((base as any)._meta && typeof (base as any)._meta === 'object')
    ? (base as any)._meta
    : {};
  return {
    ...base,
    _meta: {
      ...meta,
      version: safeNextVersion,
    },
  };
}
