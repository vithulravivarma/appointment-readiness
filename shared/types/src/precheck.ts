export type PrecheckCheckType = 'ACCESS_CONFIRMED' | 'MEDS_SUPPLIES_READY' | 'CARE_PLAN_CURRENT';

export interface PrecheckQuestion {
  checkType: PrecheckCheckType;
  prompt: string;
  passSignals: string[];
  failSignals: string[];
}

export interface PrecheckProfile {
  id: 'HOME_CARE' | 'TRADES' | 'CLINICAL';
  label: string;
  matchKeywords: string[];
  objective: string;
  questions: PrecheckQuestion[];
}

const HOME_CARE_PROFILE: PrecheckProfile = {
  id: 'HOME_CARE',
  label: 'Home Care',
  matchKeywords: ['aba', 'home care', 'caregiving', 'family support', 'therapy'],
  objective: 'Complete pre-readiness checklist and escalate unresolved blockers.',
  questions: [
    {
      checkType: 'ACCESS_CONFIRMED',
      prompt: 'Do you have confirmed home access for the visit (code/key/unlocked entry)?',
      passSignals: ['code', 'key', 'unlock', 'unlocked', 'entry confirmed', 'access confirmed'],
      failSignals: ['no code', 'no key', 'cant enter', 'cannot enter', 'locked out', 'gate locked'],
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required medications and supplies ready for the visit?',
      passSignals: ['meds ready', 'medications ready', 'supplies ready', 'prepared', 'available', 'set up'],
      failSignals: ['out of', 'missing', 'not ready', 'no meds', 'no supplies', 'need refill'],
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Do you have current care instructions for this visit and have there been any updates?',
      passSignals: ['care plan updated', 'instructions updated', 'plan current', 'same plan', 'confirmed instructions'],
      failSignals: ['no plan', 'outdated', 'not sure', 'unclear instructions', 'need updated plan'],
    },
  ],
};

const TRADES_PROFILE: PrecheckProfile = {
  id: 'TRADES',
  label: 'Trades',
  matchKeywords: ['plumb', 'hvac', 'electri', 'repair', 'installation', 'trade', 'contractor'],
  objective: 'Complete pre-arrival checklist for the trade visit and escalate unresolved blockers.',
  questions: [
    {
      checkType: 'ACCESS_CONFIRMED',
      prompt: 'Can the technician access the work area when they arrive (entry code, gate, parking, on-site contact)?',
      passSignals: ['access confirmed', 'entry confirmed', 'gate open', 'parking available', 'onsite contact'],
      failSignals: ['no access', 'no gate code', 'cant enter', 'cannot enter', 'no parking', 'not home'],
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required materials/equipment available on-site, or should the technician bring everything?',
      passSignals: ['materials ready', 'equipment ready', 'bring everything', 'all set', 'available onsite'],
      failSignals: ['missing parts', 'no materials', 'not available', 'need parts', 'backorder'],
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Is the job scope still the same, or are there updates the technician should know before arrival?',
      passSignals: ['scope unchanged', 'same scope', 'updated scope shared', 'details confirmed'],
      failSignals: ['scope changed', 'new issue', 'unclear scope', 'not sure on details'],
    },
  ],
};

const CLINICAL_PROFILE: PrecheckProfile = {
  id: 'CLINICAL',
  label: 'Clinical',
  matchKeywords: ['dental', 'dentist', 'clinic', 'clinical', 'hygiene', 'orthodont'],
  objective: 'Complete appointment readiness checks and escalate unresolved clinical-visit blockers.',
  questions: [
    {
      checkType: 'ACCESS_CONFIRMED',
      prompt: 'Is clinic access/arrival logistics confirmed (transport, check-in timing, and location details)?',
      passSignals: ['transport confirmed', 'arrival confirmed', 'check in confirmed', 'location confirmed'],
      failSignals: ['no transport', 'running late', 'wrong location', 'cant make it'],
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required documents/medications/items ready for the appointment (ID, forms, med list, etc.)?',
      passSignals: ['documents ready', 'forms ready', 'med list ready', 'everything ready'],
      failSignals: ['missing documents', 'forms not done', 'forgot id', 'not ready'],
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Are there any new care or treatment updates the clinic team should know before the visit?',
      passSignals: ['no updates', 'updates shared', 'plan current', 'instructions current'],
      failSignals: ['new symptoms', 'new issue', 'plan changed', 'need to update'],
    },
  ],
};

export const PRECHECK_PROFILES: PrecheckProfile[] = [
  HOME_CARE_PROFILE,
  TRADES_PROFILE,
  CLINICAL_PROFILE,
];

export function getDefaultPrecheckProfile(): PrecheckProfile {
  return HOME_CARE_PROFILE;
}

export function resolvePrecheckProfile(serviceType?: string | null): PrecheckProfile {
  const value = String(serviceType || '').toLowerCase();
  if (!value) return getDefaultPrecheckProfile();

  for (const profile of PRECHECK_PROFILES) {
    if (profile.matchKeywords.some((keyword) => value.includes(keyword))) {
      return profile;
    }
  }

  return getDefaultPrecheckProfile();
}
