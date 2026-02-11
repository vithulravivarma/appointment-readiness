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

// 1. Ensure standard checks exist for this appointment
export async function ensureChecklistExists(pool: Pool, appointmentId: string): Promise<void> {
  const defaultChecks = ['ACCESS_CODE', 'SAFETY_ASSESSMENT', 'CAREGIVER_CONFIRMATION'];
  
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
    checks: res.rows[0].checks
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
  await pool.query(`
    UPDATE readiness_checks
    SET status = $3, updated_at = NOW()
    WHERE appointment_id = $1 AND check_type = $2
  `, [appointmentId, checkType, status]);
}

// 5. Bulk update for general confirmations (e.g. "Yes I'm ready" passes everything)
export async function resolveAllChecks(pool: Pool, appointmentId: string): Promise<void> {
  await pool.query(`
    UPDATE readiness_checks
    SET status = 'PASS', updated_at = NOW()
    WHERE appointment_id = $1 AND status = 'PENDING'
  `, [appointmentId]);
}