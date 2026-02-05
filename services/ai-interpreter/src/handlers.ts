import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, Message } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import OpenAI from 'openai';
// Remove the Zod helper import since we will parse manually
// import { zodResponseFormat } from 'openai/helpers/zod'; 
import { ReadinessAnalysisSchema } from './schema';

// --- CONFIGURATION ---
const CHAT_QUEUE_URL = 'http://localhost:4566/000000000000/incoming-messages-queue';
const UPDATE_QUEUE_URL = 'http://localhost:4566/000000000000/readiness-updates-queue';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function initializeConsumers(sqs: SQSClient, pool: Pool) {
  console.log('[AI] 🧠 Consumers Initialized (Standard Mode)...');
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
          await processChatMessage(sqs, msg);
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

async function processChatMessage(sqs: SQSClient, msg: Message) {
  if (!msg.Body) return;

  try {
    const body = JSON.parse(msg.Body);
    const text = body.text || '';
    const appointmentId = body.appointmentId;

    if (body.senderType && body.senderType !== 'CAREGIVER') return;

    console.log(`[AI] 🧠 Analyzing: "${text}"`);

    // 1. CALL OPENAI (Standard Method)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Or "gpt-3.5-turbo-0125" if you want to save cost
      response_format: { type: "json_object" }, // Forces JSON output
      messages: [
        { 
          role: "system", 
          content: `You are a Healthcare Logistics AI. Output valid JSON only.
          
          Analyze the user text for these categories:
          - ACCESS_CODE: Gate codes, lockboxes, keys.
          - SAFETY_ASSESSMENT: Safe environment, no hazards.
          - CAREGIVER_CONFIRMATION: "I am ready", "Confirmed".

          Return JSON with this structure:
          {
            "updates": [
              { "category": "CATEGORY_NAME", "status": "PASS" | "FAIL", "confidence": 0.9, "reasoning": "..." }
            ],
            "summary": "..."
          }
          
          If no updates found, return empty array for updates.` 
        },
        { role: "user", content: text },
      ],
      temperature: 0, 
    });

    const content = completion.choices[0].message.content;
    if (!content) return;

    // 2. MANUALLY PARSE AND VALIDATE
    let analysis;
    try {
      const rawJson = JSON.parse(content);
      // Optional: Use Zod to validate the raw JSON matches our types
      analysis = ReadinessAnalysisSchema.parse(rawJson);
    } catch (e) {
      console.error('[AI] JSON Parse Failed:', e);
      return;
    }

    // 3. SEND UPDATES
    console.log(`[AI] Summary: ${analysis.summary}`);

    for (const update of analysis.updates) {
      if (update.confidence > 0.85) {
        console.log(`[AI] 🚀 Update Detected: ${update.category} -> ${update.status}`);
        
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

  } catch (error) {
    console.error('[AI] Logic Error:', error);
  }
}