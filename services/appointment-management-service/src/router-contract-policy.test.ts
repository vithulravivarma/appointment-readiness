import {
  applyRouterContractDefaults,
  inferRequiredSlots,
  normalizeRequiredSlots,
  normalizeResponseStyle,
} from './router-contract-policy';

describe('router-contract-policy', () => {
  test('normalizes and dedupes required slots', () => {
    const slots = normalizeRequiredSlots(['home-address', 'HOME_ADDRESS', ' appointment_target ']);
    expect(slots).toEqual(['HOME_ADDRESS', 'APPOINTMENT_TARGET']);
  });

  test('normalizes response style', () => {
    expect(normalizeResponseStyle('step by step')).toBe('STEP_BY_STEP');
    expect(normalizeResponseStyle('concise')).toBe('CONCISE');
  });

  test('infers slots for maps follow-up', () => {
    const inferred = inferRequiredSlots({ action: 'ASK_FOLLOW_UP', tool: 'MAPS_ROUTE' });
    expect(inferred).toEqual(['HOME_ADDRESS']);
  });

  test('infers appointment target for client-info/delegation follow-up', () => {
    expect(inferRequiredSlots({ action: 'ASK_FOLLOW_UP', tool: 'CLIENT_INFO', infoQuestion: 'access code?' })).toEqual([
      'APPOINTMENT_TARGET',
    ]);
    expect(
      inferRequiredSlots({ action: 'ASK_FOLLOW_UP', tool: 'START_DELEGATION', objective: 'confirm gate code' }),
    ).toEqual(['APPOINTMENT_TARGET']);
  });

  test('applies defaults when contract fields are missing', () => {
    const normalized = applyRouterContractDefaults({ action: 'RESPOND' as const });
    expect(normalized.responseStyle).toBe('CONCISE');
    expect(normalized.requiredSlots).toEqual([]);
  });
});
