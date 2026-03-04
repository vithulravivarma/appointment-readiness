export type RouterAction = 'RESPOND' | 'ASK_FOLLOW_UP' | 'USE_TOOL';
export type RouterTool = 'SCHEDULE_DAY' | 'MAPS_ROUTE' | 'CLIENT_INFO' | 'START_DELEGATION';
export type RouterRequiredSlot =
  | 'APPOINTMENT_TARGET'
  | 'HOME_ADDRESS'
  | 'CLIENT_INFO_QUESTION'
  | 'DELEGATION_OBJECTIVE';
export type RouterResponseStyle = 'CONCISE' | 'STEP_BY_STEP';

const REQUIRED_SLOT_VALUES = new Set<RouterRequiredSlot>([
  'APPOINTMENT_TARGET',
  'HOME_ADDRESS',
  'CLIENT_INFO_QUESTION',
  'DELEGATION_OBJECTIVE',
]);

function normalizeSlotName(value: unknown): RouterRequiredSlot | null {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (REQUIRED_SLOT_VALUES.has(normalized as RouterRequiredSlot)) {
    return normalized as RouterRequiredSlot;
  }
  return null;
}

export function normalizeRequiredSlots(raw: unknown): RouterRequiredSlot[] {
  if (!Array.isArray(raw)) return [];
  const unique: RouterRequiredSlot[] = [];
  const seen = new Set<RouterRequiredSlot>();
  for (const item of raw) {
    const slot = normalizeSlotName(item);
    if (!slot || seen.has(slot)) continue;
    seen.add(slot);
    unique.push(slot);
  }
  return unique;
}

export function normalizeResponseStyle(raw: unknown): RouterResponseStyle | undefined {
  const normalized = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'CONCISE') return 'CONCISE';
  if (normalized === 'STEP_BY_STEP') return 'STEP_BY_STEP';
  return undefined;
}

export function inferRequiredSlots(input: {
  action: RouterAction;
  tool?: RouterTool;
  objective?: string;
  infoQuestion?: string;
}): RouterRequiredSlot[] {
  if (input.action !== 'ASK_FOLLOW_UP') return [];

  const inferred: RouterRequiredSlot[] = [];
  if (input.tool === 'MAPS_ROUTE') {
    inferred.push('HOME_ADDRESS');
  }

  if (input.tool === 'CLIENT_INFO' || input.tool === 'START_DELEGATION') {
    inferred.push('APPOINTMENT_TARGET');
  }

  if (input.tool === 'CLIENT_INFO' && !String(input.infoQuestion || '').trim()) {
    inferred.push('CLIENT_INFO_QUESTION');
  }

  if (input.tool === 'START_DELEGATION' && !String(input.objective || '').trim()) {
    inferred.push('DELEGATION_OBJECTIVE');
  }

  return Array.from(new Set(inferred));
}

export function applyRouterContractDefaults<T extends {
  action: RouterAction;
  tool?: RouterTool;
  objective?: string;
  infoQuestion?: string;
  requiredSlots?: unknown;
  responseStyle?: unknown;
}>(decision: T): T & { requiredSlots: RouterRequiredSlot[]; responseStyle: RouterResponseStyle } {
  const normalizedSlots = normalizeRequiredSlots(decision.requiredSlots);
  const requiredSlots = normalizedSlots.length > 0
    ? normalizedSlots
    : inferRequiredSlots({
        action: decision.action,
        tool: decision.tool,
        objective: decision.objective,
        infoQuestion: decision.infoQuestion,
      });
  const responseStyle = normalizeResponseStyle(decision.responseStyle) || 'CONCISE';

  return {
    ...decision,
    requiredSlots,
    responseStyle,
  };
}
