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
  // In the future, you can make this dynamic based on Service Type (e.g. only some need Meds)
  const defaultChecks = ['ACCESS_CODE', 'SAFETY_ASSESSMENT', 'CAREGIVER_CONFIRMATION'];
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const check of defaultChecks) {
      await client.query(`
        INSERT INTO readiness_checks (appointment_id, check_type, status)
        VALUES ($1, $2, 'PENDING')
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
  const res = await pool.query(`
    SELECT 
      ar.status, 
      ar.risk_score,
      json_agg(json_build_object('type', rc.check_type, 'status', rc.status)) as checks
    FROM appointment_readiness ar
    LEFT JOIN readiness_checks rc ON ar.appointment_id = rc.appointment_id
    WHERE ar.appointment_id = $1
    GROUP BY ar.appointment_id
  `, [appointmentId]);

  if (res.rows.length === 0) {
    throw new Error(`Appointment ${appointmentId} not found`);
  }

  return {
    appointmentId,
    status: res.rows[0].status,
    riskScore: res.rows[0].risk_score,
    checks: res.rows[0].checks || []
  };
}

// 3. Update the overall status
export async function updateReadinessStatus(pool: Pool, appointmentId: string, status: string, score: number): Promise<void> {
  await pool.query(`
    UPDATE appointment_readiness
    SET status = $2, risk_score = $3, last_evaluated_at = NOW()
    WHERE appointment_id = $1
  `, [appointmentId, status, score]);
}

// 4. Update a specific check (e.g. mark MEDICATION as PASS)
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