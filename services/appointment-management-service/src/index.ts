// services/appointment-management-service/src/index.ts
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { loadConfig } from './config';
import { initializeDatabase, testConnection } from './db';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// --- 1. SETUP & CONFIG ---
const config = loadConfig();
// FORCE PORT 3001 (To match your Frontend error URL)
const PORT = process.env.PORT || 3001; 

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT || 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
});

async function main() {
  console.log('[STARTUP] 🚀 Initializing Service...');

  // --- 2. DATABASE ---
  const pool = initializeDatabase(config.database);
  await testConnection(pool);

  // --- 3. SERVER & CORS (THE FIX) ---
  const app = express();

  // A. The Package
  app.use(cors());

  // B. The Manual Override (Nuclear Option)
  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`); // Log every hit!
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    next();
  });

  app.use(express.json());

  // --- 4. ROUTES ---

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', port: PORT });
  });

  // GET /appointments
  app.get('/appointments', async (req: Request, res: Response) => {
    try {
      // 1. Extract the generic userId and role
      const { userId, role, caregiverId } = req.query;
      
      // Fallback just in case the frontend still sends caregiverId
      const targetId = userId || caregiverId; 

      if (!targetId && role !== 'COORDINATOR') {
        return res.status(400).json({ error: 'Missing userId' });
      }

      console.log(`[API] Fetching appointments for: ${targetId} (Role: ${role})`);

      // 2. DYNAMIC FILTERING LOGIC
      let userFilter = '';
      let queryParams: any[] = [];

      if (role === 'FAMILY' || role === 'PATIENT') {
        userFilter = 'WHERE a.client_id = $1';
        queryParams = [targetId];
      } else if (role === 'COORDINATOR') {
        userFilter = ''; // Coordinators see ALL appointments
        queryParams = [];
      } else {
        // Default to Caregiver
        userFilter = 'WHERE a.caregiver_id = $1';
        queryParams = [targetId];
      }

      // 3. EXECUTE THE QUERY
      const result = await pool.query(`
        SELECT 
          a.id, 
          a.aloha_appointment_id,
          a.start_time,
          a.end_time,
          a.service_type,
          a.readiness_status,
          c.name as client_name,
          c.service_address,
          c.primary_phone
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
        ${userFilter}
        ORDER BY a.start_time ASC
      `, queryParams);
      
      console.log(`[API] Found ${result.rows.length} records.`);
      res.json(result.rows);

    } catch (error) {
      console.error('[API ERROR]', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/readiness
  app.get('/appointments/:id/readiness', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      // 1. Get the High-Level Status directly from the 'appointments' table
      const summaryRes = await pool.query(`
        SELECT readiness_status 
        FROM appointments 
        WHERE id = $1
      `, [id]);

      if (summaryRes.rows.length === 0) {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      // 2. Get the specific checklist items
      const checksRes = await pool.query(`
        SELECT check_type, status, updated_at 
        FROM readiness_checks 
        WHERE appointment_id = $1
      `, [id]);

      const summary = summaryRes.rows[0];

      res.json({
        appointmentId: id,
        status: summary.readiness_status || 'NOT_STARTED',
        riskScore: 0, // Hardcoded to 0 for now to keep the UI happy
        checks: checksRes.rows
      });
    } catch (error) {
      console.error('Failed to fetch readiness:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // POST /messages
  app.post('/messages', async (req: Request, res: Response) => {
    try {
      const { appointmentId, content, senderType, senderId } = req.body;
      const finalSenderType = senderType || 'CAREGIVER';
      const finalSenderId = senderId || 'CG-DEMO-USER';

      // Traffic Cop Logic
      if (finalSenderType !== 'SYSTEM' && finalSenderType !== 'AI_AGENT') {
        await pool.query(`
          INSERT INTO user_agents (user_id, role, status, paused_until)
          VALUES ($1, $2, 'PAUSED', NOW() + INTERVAL '30 minutes')
          ON CONFLICT (user_id) DO UPDATE SET status = 'PAUSED', paused_until = NOW() + INTERVAL '30 minutes'
        `, [finalSenderId, finalSenderType]);
      }

      const dbResult = await pool.query(`
        INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
        VALUES ($1, $2, $3, $4, false)
        RETURNING id, created_at
      `, [appointmentId, finalSenderType, finalSenderId, content]);

      const newMessage = dbResult.rows[0];

      await sqs.send(new SendMessageCommand({
        QueueUrl: 'http://localhost:4566/000000000000/incoming-messages-queue',
        MessageBody: JSON.stringify({
          type: 'NEW_MESSAGE',
          appointmentId,
          text: content,
          senderType: finalSenderType,
          senderId: finalSenderId,
          messageId: newMessage.id
        })
      }));

      res.json({ success: true, data: newMessage });
    } catch (error) {
      console.error('Failed to send message', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /appointments/:id/messages
  app.get('/appointments/:id/messages', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(`
        SELECT * FROM messages WHERE appointment_id = $1 ORDER BY created_at ASC
      `, [id]);
      res.json({ data: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /agents/:userId/status
  // Fetches the current status of a user's digital twin
  app.get('/agents/:userId/status', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const result = await pool.query(
        `SELECT status FROM user_agents WHERE user_id = $1`, 
        [userId]
      );
      
      const status = result.rows[0]?.status || 'ACTIVE'; // Default to active
      res.json({ status });
    } catch (error) {
      console.error('Failed to fetch agent status', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // PUT /agents/:userId/status
  // Manually overrides the AI status (ON/OFF)
  app.put('/agents/:userId/status', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const { status } = req.body; // 'ACTIVE' or 'PAUSED'

      await pool.query(`
        INSERT INTO user_agents (user_id, role, status, paused_until)
        VALUES ($1, 'CAREGIVER', $2, NULL)
        ON CONFLICT (user_id) 
        DO UPDATE SET status = $2, paused_until = NULL
      `, [userId, status]);

      res.json({ success: true, status });
    } catch (error) {
      console.error('Failed to update agent status', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // --- 5. START SERVER ---
  app.listen(PORT, () => {
    console.log(`\n✅ SERVICE IS LIVE ON PORT ${PORT}`);
    console.log(`   👉 Test URL: http://localhost:${PORT}/health`);
    console.log(`   👉 CORS is ENABLED for everyone.\n`);
  });
}

main().catch(console.error);