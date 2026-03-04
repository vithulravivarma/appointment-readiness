export type PrecheckCheckType = 'ACCESS_CONFIRMED' | 'MEDS_SUPPLIES_READY' | 'CARE_PLAN_CURRENT';

export type PrecheckPlannerItemLike = {
  status: 'PENDING' | 'PASS' | 'FAIL';
  evidence?: string;
};

export type PrecheckPlannerStateLike = {
  items: Record<PrecheckCheckType, PrecheckPlannerItemLike>;
};

const CHECK_ORDER: PrecheckCheckType[] = ['ACCESS_CONFIRMED', 'MEDS_SUPPLIES_READY', 'CARE_PLAN_CURRENT'];

const CHECK_LABELS: Record<PrecheckCheckType, string> = {
  ACCESS_CONFIRMED: 'Access details confirmed',
  MEDS_SUPPLIES_READY: 'Medications/supplies ready',
  CARE_PLAN_CURRENT: 'Care instructions current',
};

function compactSnippet(text: string, maxLength: number): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function toReadableList(items: string[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join('; ')}; ${items[items.length - 1]}`;
}

export function buildPrecheckCompletionSummary(planner: PrecheckPlannerStateLike): string {
  const passed: string[] = [];
  const failed: string[] = [];
  const failedEvidence: string[] = [];

  for (const checkType of CHECK_ORDER) {
    const item = planner.items[checkType];
    const label = CHECK_LABELS[checkType];
    if (!item) continue;

    if (item.status === 'PASS') {
      passed.push(label);
      continue;
    }

    if (item.status === 'FAIL') {
      failed.push(label);
      const evidence = compactSnippet(item.evidence || '', 140);
      if (evidence) {
        failedEvidence.push(`${label}: ${evidence}`);
      }
    }
  }

  const resolved = failed.length === 0;
  const statusLine = resolved ? 'Precheck complete: Ready for visit.' : 'Precheck complete: Caregiver follow-up required.';
  const confirmedLine = passed.length > 0 ? `Confirmed: ${toReadableList(passed)}.` : 'Confirmed: no checks explicitly confirmed.';

  if (resolved) {
    return [
      statusLine,
      confirmedLine,
      'Caregiver action: No blocker detected. Continue normal visit prep.',
    ].join(' ');
  }

  return [
    statusLine,
    confirmedLine,
    `Open blockers: ${toReadableList(failed)}.`,
    failedEvidence.length > 0 ? `Latest evidence: ${failedEvidence.join(' | ')}.` : null,
    'Caregiver action: Resolve open blockers before visit start or escalate as needed.',
  ]
    .filter(Boolean)
    .join(' ');
}
