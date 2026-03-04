import { getAgentSettingsVersion, withAgentSettingsVersion } from './agent-settings-policy';

describe('agent-settings-policy', () => {
  test('reads version from metadata and defaults to zero', () => {
    expect(getAgentSettingsVersion({ _meta: { version: 4 } })).toBe(4);
    expect(getAgentSettingsVersion({})).toBe(0);
    expect(getAgentSettingsVersion(null)).toBe(0);
  });

  test('clamps invalid versions to non-negative integers', () => {
    expect(getAgentSettingsVersion({ _meta: { version: -3 } })).toBe(0);
    expect(getAgentSettingsVersion({ _meta: { version: 3.8 } })).toBe(3);
    expect(getAgentSettingsVersion({ _meta: { version: Number.NaN } })).toBe(0);
  });

  test('writes incremented version without dropping existing metadata', () => {
    const next = withAgentSettingsVersion({ _meta: { version: 2 }, profile: 'A' }, 3);
    expect(next).toEqual({ _meta: { version: 3 }, profile: 'A' });
  });
});
