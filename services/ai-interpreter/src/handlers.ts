// services/ai-interpreter-service/src/handlers.ts
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, Message } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import OpenAI from 'openai';
import { ReadinessAnalysisSchema } from './schema';

// --- CONFIGURATION ---
const CHAT_QUEUE_URL = 'http://localhost:4566/000000000000/incoming-messages-queue';
const UPDATE_QUEUE_URL = 'http://localhost:4566/000000000000/readiness-updates-queue';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- CONSUMER LOOP ---
export async function initializeConsumers(sqs: SQSClient, pool: Pool) {
  console.log('[AI] 🧠 Super-Worker Initialized (Analyst + Agent)...');
  
  // We pass the pool down so we can check the "Traffic Cop" DB tables
  pollChatQueue(sqs, pool).catch(err => {
    console.error('[AI] Fatal Loop Error:', err);
  });
}

async function pollChatQueue(sqs: SQSClient, pool: Pool) {
  while (true) {
    try {
      const { Messages } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: CHAT_QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 5
      }));

      if (Messages && Messages.length > 0) {
        for (const msg of Messages) {
          // Pass the pool to the processor
          await processChatMessage(sqs, pool, msg);
          
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: CHAT_QUEUE_URL, ReceiptHandle: msg.ReceiptHandle
          }));
        }
      }
    } catch (error) {
      console.error('[AI] Polling Error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// --- MAIN PROCESSOR ---
async function processChatMessage(sqs: SQSClient, pool: Pool, msg: Message) {
  if (!msg.Body) return;

  try {
    const body = JSON.parse(msg.Body);
    const text = body.text || '';
    const appointmentId = body.appointmentId;
    const senderType = body.senderType;
    const senderId = body.senderId;

    // IGNORE: Messages sent by the System or the AI itself (Prevent Loops)
    if (senderType === 'SYSTEM' || senderType === 'AI_AGENT') return;

    console.log(`\n[AI] 📨 Processing: "${text}" from ${senderType}`);

    // --- JOB 1: THE READINESS ANALYST (If Caregiver speaks) ---
    if (senderType === 'CAREGIVER') {
       await runReadinessAnalysis(sqs, text, appointmentId);
    }

    // --- JOB 2: THE CHAT AGENT (If Family speaks) ---
    // If Family speaks, the CAREGIVER'S AGENT should reply.
    if (senderType === 'FAMILY') {
      await runCaregiverAgent(pool, text, appointmentId, senderId);
    }

  } catch (error) {
    console.error('[AI] Logic Error:', error);
  }
}

// --- SUB-ROUTINE 1: READINESS ANALYSIS (Your Existing Logic) ---
async function runReadinessAnalysis(sqs: SQSClient, text: string, appointmentId: string) {
  console.log(`[AI] 🔍 Analyzing for logistics updates...`);
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      { 
        role: "system", 
        content: `You are an intelligent Healthcare Logistics Assistant. Your job is to read natural conversation from caregivers and deduce if certain readiness checks have been met. Output valid JSON only.
        
        Evaluate the text for these categories:
        1. ACCESS_CODE: Has the caregiver obtained the means to enter the property? (e.g., they mention a code, finding a key, or a neighbor letting them in).
        2. SAFETY_ASSESSMENT: Does the text imply the environment is safe or hazard-free? (e.g., "dogs are put away", "porch is clear of ice").
        3. CAREGIVER_CONFIRMATION: Is the caregiver indicating they are ready, on-site, or good to go?

        For each category you detect, determine if the status should be "PASS" (issue resolved/confirmed) or "FAIL" (issue blocked/needs help).

        Return JSON with this exact structure:
        {
          "updates": [
            { 
              "category": "CATEGORY_NAME", 
              "reasoning": "Explain in one sentence why you chose PASS or FAIL based on the context.",
              "status": "PASS" | "FAIL", 
              "confidence": 0.9 
            }
          ]
        }
        
        If the text is unrelated to these checks, return {"updates": []}.` 
      },
      { role: "user", content: text },
    ],
    temperature: 0, 
  });

  const content = completion.choices[0].message.content;
  if (!content) return;

  try {
    const analysis = JSON.parse(content); // (Add Zod validation here if you want)
    
    // Send Updates
    for (const update of analysis.updates || []) {
      if (update.confidence > 0.85) {
        console.log(`[AI] 🚀 Readiness Update: ${update.category} -> ${update.status}`);
        await sqs.send(new SendMessageCommand({
          QueueUrl: UPDATE_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: 'UPDATE_CHECK',
            appointmentId: appointmentId,
            checkType: update.category,
            status: update.status,
            source: 'AI_GPT4'
          })
        }));
      }
    }
  } catch (e) {
    console.error('[AI] Analysis Parse Error', e);
  }
}

// --- SUB-ROUTINE 2: THE DIGITAL TWIN AGENT (New Logic) ---
async function runCaregiverAgent(pool: Pool, userText: string, appointmentId: string, familyId: string) {
  console.log(`[AI] 🤖 Checking if Caregiver Agent should reply...`);

  // 1. Find who the Caregiver is for this appointment
  const apptResult = await pool.query(`SELECT caregiver_id FROM appointments WHERE id = $1`, [appointmentId]);
  if (apptResult.rows.length === 0) return;
  const caregiverId = apptResult.rows[0].caregiver_id;

  // 2. TRAFFIC COP: Check if Caregiver Agent is PAUSED
  const agentResult = await pool.query(`SELECT status FROM user_agents WHERE user_id = $1`, [caregiverId]);
  const status = agentResult.rows[0]?.status || 'ACTIVE';

  if (status === 'PAUSED') {
    console.log(`[AI] 🛑 Agent BLOCKED: Caregiver ${caregiverId} is PAUSED.`);
    return;
  }

  // 3. GENERATE REPLY (Using OpenAI)
  console.log(`[AI] ✅ Agent ACTIVE: Generating reply...`);
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { 
        role: "system", 
        content: `You are the AI Digital Twin for a professional caregiver. 
        You are speaking to a patient's family member.
        - Be polite, professional, and reassuring.
        - Keep it brief (SMS style).
        - If they ask about arrival, say you are checking the schedule.
        - Do not make up medical promises.` 
      },
      { role: "user", content: userText },
    ],
    temperature: 0.7, // Higher creativity for conversation
  });

  const replyText = completion.choices[0].message.content;

  // 4. INSERT REPLY INTO DB
  await pool.query(`
    INSERT INTO messages (appointment_id, sender_type, sender_id, content, is_agent)
    VALUES ($1, 'AI_AGENT', $2, $3, true)
  `, [appointmentId, caregiverId, replyText]);

  console.log(`[AI] 🗣️ Sent Reply: "${replyText}"`);
}