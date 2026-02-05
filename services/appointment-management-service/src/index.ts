import { Request, Response } from 'express';
import { loadConfig } from './config';
import { initializeDatabase, testConnection } from './db';
import { createServer } from './server';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';


const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
});

async function main() {
  console.log('[STARTUP] Starting appointment-management-service...');
  const config = loadConfig();

  // 1. Connect to Real DB
  const pool = initializeDatabase(config.database);
  await testConnection(pool);

  const app = createServer();

  // --- REAL ENDPOINTS ---

  // GET /appointments
  // Returns real appointments joined with their readiness status
  app.get('/appointments', async (req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT 
          a.id, 
          a.aloha_appointment_id,
          a.start_time,
          a.service_type,
          c.name as client_name,
          ar.status as readiness_status,
          ar.risk_score
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
        LEFT JOIN appointment_readiness ar ON a.id = ar.appointment_id
        ORDER BY a.start_time ASC
      `);
      
      res.json({ data: result.rows });
    } catch (error) {
      console.error('Failed to fetch appointments', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/readiness
  // Returns the specific checklist for one appointment
  app.get('/appointments/:id/readiness', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      // Fetch checks
      const checksRes = await pool.query(`
        SELECT check_type, status, details 
        FROM readiness_checks 
        WHERE appointment_id = $1
      `, [id]);

      // Fetch summary
      const summaryRes = await pool.query(`
        SELECT status, risk_score 
        FROM appointment_readiness 
        WHERE appointment_id = $1
      `, [id]);

      if (summaryRes.rows.length === 0) {
        res.status(404).json({ error: 'Appointment not found' });
        return;
      }

      res.json({
        appointmentId: id,
        summary: summaryRes.rows[0],
        checklist: checksRes.rows
      });
    } catch (error) {
      console.error('Failed to fetch readiness details', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/messages', async (req: Request, res: Response) => {
    try {
      const { appointmentId, content } = req.body;
      
      // SECURITY: We force the type to CAREGIVER because this API is for the App.
      const senderType = 'CAREGIVER';
      const senderId = 'CG-DEMO-USER'; // In real life, this comes from the auth token

      // A. Save to Database (The Truth)
      const dbResult = await pool.query(`
        INSERT INTO messages (appointment_id, sender_type, sender_id, content)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at
      `, [appointmentId, senderType, senderId, content]);

      const newMessage = dbResult.rows[0];

      // B. Push to Queue (The Brain)
      // We explicitly tell the AI: "A CAREGIVER sent this."
      await sqs.send(new SendMessageCommand({
        QueueUrl: 'http://localhost:4566/000000000000/incoming-messages-queue',
        MessageBody: JSON.stringify({
          type: 'NEW_MESSAGE',
          appointmentId,
          text: content,
          senderType, // <--- Context for the AI
          senderId,
          messageId: newMessage.id
        })
      }));

      console.log(`[CHAT] Processed message: ${content}`);
      res.json({ success: true, data: newMessage });
    } catch (error) {
      console.error('Failed to send message', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/messages
  // Returns history
  app.get('/appointments/:id/messages', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`
        SELECT * FROM messages 
        WHERE appointment_id = $1 
        ORDER BY created_at ASC
      `, [id]);
      
      res.json({ data: result.rows });
    } catch (error) {
      console.error('Failed to fetch messages', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/appointments/:id/readiness', async (req, res) => {
  const { id } = req.params;
  
  try {
    // 1. Get the High-Level Status (Green/Red)
    const readinessResult = await pool.query(`
      SELECT status, risk_score, last_evaluated_at 
      FROM appointment_readiness 
      WHERE appointment_id = $1
    `, [id]);

    // Default to 'PENDING' if the engine hasn't run yet
    const summary = readinessResult.rows[0] || { status: 'PENDING', risk_score: 0 };

    // 2. Get the Specific Checklist (The "Why")
    const checksResult = await pool.query(`
      SELECT check_type, status, updated_at 
      FROM readiness_checks 
      WHERE appointment_id = $1
    `, [id]);

    res.json({
      appointmentId: id,
      status: summary.status,      // READY, BLOCKED, PRE_CHECK
      riskScore: summary.risk_score,
      checks: checksResult.rows    // Array of { check_type: 'ACCESS_CODE', status: 'PASS' }
    });

  } catch (error) {
    console.error('Failed to fetch readiness:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

  const server = app.listen(config.port, () => {
    console.log(`✅ Appointment API (Real Data) running on port ${config.port}`);
  });
}

main().catch(console.error);