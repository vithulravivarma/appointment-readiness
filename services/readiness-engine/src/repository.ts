// services/readiness-engine/src/repository.ts
import { Pool } from 'pg';

export interface ReadinessState {
  appointmentId: string;
  status: string;
  riskScore: number;
  checks: Array<{
    type: string;
    status: string;
  }>;
}

export interface ChecklistDefinition {
  key: string;
  critical: boolean;
  description: string;
}

export const CHECKLIST_DEFINITIONS: ChecklistDefinition[] = [
  { key: 'ACCESS_CONFIRMED', critical: true, description: 'Home access is confirmed for the visit.' },
  { key: 'MEDS_SUPPLIES_READY', critical: true, description: 'Required medications and supplies are available.' },
  { key: 'CARE_PLAN_CURRENT', critical: true, description: 'Care plan and instructions are current for this visit.' },
  { key: 'CAREGIVER_MATCH_CONFIRMED', critical: false, description: 'Caregiver fit/certification context is validated.' },
  { key: 'EXPECTATIONS_ALIGNED', critical: false, description: 'Family and caregiver expectations are aligned.' },
  { key: 'VISIT_BRIEF_READY', critical: false, description: 'Caregiver brief is generated and acknowledged.' },
];

const CHECK_ALIASES: Record<string, string> = {
  ACCESS_CODE: 'ACCESS_CONFIRMED',
  SAFETY_ASSESSMENT: 'MEDS_SUPPLIES_READY',
  CAREGIVER_CONFIRMATION: 'CAREGIVER_MATCH_CONFIRMED',
};

// 1. Ensure standard checks exist for this appointment
export async function ensureChecklistExists(pool: Pool, appointmentId: string): Promise<void> {
  const defaultChecks = CHECKLIST_DEFINITIONS.map((c) => c.key);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const check of defaultChecks) {
      await client.query(`
        INSERT INTO readiness_checks (appointment_id, check_type, status, updated_at)
        VALUES ($1, $2, 'PENDING', NOW())
        ON CONFLICT (appointment_id, check_type) DO NOTHING
      `, [appointmentId, check]);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 2. Fetch the full state (Readiness + Checks)
export async function getReadinessState(pool: Pool, appointmentId: string): Promise<ReadinessState> {
  // FIXED: Query the 'appointments' table instead of 'appointment_readiness'
  const res = await pool.query(`
    SELECT 
      a.readiness_status as status, 
      0 as risk_score, -- Hardcoded to 0 since we removed this column to simplify
      COALESCE(
        json_agg(json_build_object('type', rc.check_type, 'status', rc.status)) 
        FILTER (WHERE rc.check_type IS NOT NULL), 
        '[]'
      ) as checks
    FROM appointments a
    LEFT JOIN readiness_checks rc ON a.id = rc.appointment_id
    WHERE a.id = $1
    GROUP BY a.id, a.readiness_status
  `, [appointmentId]);

  if (res.rows.length === 0) {
    throw new Error(`Appointment ${appointmentId} not found`);
  }

  return {
    appointmentId,
    status: res.rows[0].status || 'NOT_STARTED',
    riskScore: res.rows[0].risk_score,
    checks: (res.rows[0].checks || []).filter((c: any) =>
      CHECKLIST_DEFINITIONS.some((d) => d.key === String(c.type))
    )
  };
}

// 3. Update the overall status
export async function updateReadinessStatus(pool: Pool, appointmentId: string, status: string, score: number): Promise<void> {
  // FIXED: Update the 'appointments' table directly
  await pool.query(`
    UPDATE appointments
    SET readiness_status = $2
    WHERE id = $1
  `, [appointmentId, status]);
}

// 4. Update a specific check (e.g. mark ACCESS_CODE as PASS)
export async function updateCheckStatus(pool: Pool, appointmentId: string, checkType: string, status: string): Promise<void> {
  const canonicalCheckType = normalizeCheckType(checkType);
  const normalizedStatus = String(status || '').trim().toUpperCase();
  if (!['PENDING', 'PASS', 'FAIL'].includes(normalizedStatus)) {
    throw new Error(`Invalid check status: ${status}`);
  }

  await pool.query(`
    INSERT INTO readiness_checks (appointment_id, check_type, status, source, updated_at)
    VALUES ($1::uuid, $2, $3, 'AI', NOW())
    ON CONFLICT (appointment_id, check_type)
    DO UPDATE SET
      status = EXCLUDED.status,
      source = EXCLUDED.source,
      updated_at = NOW()
  `, [appointmentId, canonicalCheckType, normalizedStatus]);
}

// 5. Bulk update for general confirmations (e.g. "Yes I'm ready" passes everything)
export async function resolveAllChecks(pool: Pool, appointmentId: string): Promise<void> {
  await pool.query(`
    UPDATE readiness_checks
    SET status = 'PASS', updated_at = NOW()
    WHERE appointment_id = $1 AND status = 'PENDING'
  `, [appointmentId]);
}

function normalizeCheckType(checkType: string): string {
  const normalized = String(checkType || '').trim().toUpperCase();
  return CHECK_ALIASES[normalized] || normalized;
}
