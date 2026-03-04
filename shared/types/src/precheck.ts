export type PrecheckCheckType = 'ACCESS_CONFIRMED' | 'MEDS_SUPPLIES_READY' | 'CARE_PLAN_CURRENT';

export interface PrecheckQuestion {
  checkType: PrecheckCheckType;
  prompt: string;
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
      prompt: 'Has the way to access your home changed since the last visit? If not, how should the caregiver access it today?',
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required medications and supplies ready for the visit?',
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Have there been any updates to visit instructions since the last visit?',
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
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required materials/equipment available on-site, or should the technician bring everything?',
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Has the job scope changed since the last visit?',
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
    },
    {
      checkType: 'MEDS_SUPPLIES_READY',
      prompt: 'Are required documents/medications/items ready for the appointment (ID, forms, med list, etc.)?',
    },
    {
      checkType: 'CARE_PLAN_CURRENT',
      prompt: 'Are there any updates the clinic team should know before the visit?',
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
