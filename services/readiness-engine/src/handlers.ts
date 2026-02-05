import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg'; 
import { ReadinessEvaluationEvent, NotificationJob } from '@ar/types';
import { subscribeToQueue, publishMessage } from './sqs';
// Make sure updateCheckStatus is imported from your repository
import { ensureChecklistExists, getReadinessState, updateReadinessStatus, updateCheckStatus } from './repository';
import { evaluateReadiness } from './logic';

// Define the shape of the message coming from Phase 3 AI
interface AIUpdateEvent {
  type: 'UPDATE_CHECK';
  appointmentId: string;
  checkType: string;
  status: 'PASS' | 'FAIL';
  source: string;
}

// --- PHASE 1 HANDLER (Keep this exactly as is) ---
export async function handleReadinessEvaluation(
  message: Message, 
  sqsClient: SQSClient,
  pool: Pool 
): Promise<void> {
  if (!message.Body) return;

  try {
    const event = JSON.parse(message.Body) as ReadinessEvaluationEvent;
    console.log(`[HANDLER] Processing ${event.appointmentId} (Trigger: ${event.trigger})`);

    // 1. Ensure checks exist
    await ensureChecklistExists(pool, event.appointmentId);

    // 2. Get current state
    const currentState = await getReadinessState(pool, event.appointmentId);

    // 3. Run rules
    const result = evaluateReadiness(currentState);

    // 4. Save result if changed
    if (result.nextStatus !== currentState.status) {
      await updateReadinessStatus(pool, event.appointmentId, result.nextStatus, result.riskScore);
      console.log(`[DB] Updated status to ${result.nextStatus}`);
    }

    // 5. Notify
    if (result.shouldNotify) {
      const notification: NotificationJob = {
        type: 'SMS',
        recipient: '+15550000000',
        templateId: result.nextStatus === 'BLOCKED' ? 'ESCALATION_ALERT' : 'READY_CONFIRMATION',
        data: { appointmentId: event.appointmentId, status: result.nextStatus }
      };
      await publishMessage(sqsClient, 'notification-queue', notification);
    }

  } catch (error) {
    console.error('[HANDLER] Failed to process message', error);
  }
}

// --- INITIALIZATION ---
export async function initializeConsumers(sqsClient: SQSClient, pool: Pool): Promise<void> {
  // 1. Phase 1: Periodic/Triggered Evaluations
  await subscribeToQueue(sqsClient, 'readiness-evaluation-queue', (msg) => 
    handleReadinessEvaluation(msg, sqsClient, pool)
  );

  // 2. Phase 3: AI Chat Updates
  // We updated the queue name to match what we created in LocalStack today
  await subscribeToQueue(sqsClient, 'readiness-updates-queue', (msg) => 
    handleAISignal(msg, sqsClient, pool)
  );
  
  console.log('[HANDLERS] Consumers initialized for: readiness-evaluation-queue, readiness-updates-queue');
}

// --- PHASE 3 HANDLER (Updated for Chat Workflow) ---
export async function handleAISignal(message: Message, sqsClient: SQSClient, pool: Pool): Promise<void> {
  if (!message.Body) return;

  try {
    const body = JSON.parse(message.Body);
    
    // We only care about the specific UPDATE_CHECK event from the AI
    if (body.type === 'UPDATE_CHECK') {
      const event = body as AIUpdateEvent;
      console.log(`[HANDLERS] 🤖 AI Update: Setting ${event.checkType} to ${event.status} for ${event.appointmentId}`);

      // 1. DB: Update the specific check (e.g., ACCESS_CODE)
      // This is more precise than resolving *all* checks
      await updateCheckStatus(pool, event.appointmentId, event.checkType, event.status);

      // 2. DB: Get the new state (refresh everything)
      const newState = await getReadinessState(pool, event.appointmentId);

      // 3. LOGIC: Re-evaluate the Score (Does this specific fix make the whole appt READY?)
      const result = evaluateReadiness(newState);

      // 4. DB: Update the parent status if it changed
      if (result.nextStatus !== newState.status) {
        await updateReadinessStatus(pool, event.appointmentId, result.nextStatus, result.riskScore);
        console.log(`[DB] 🔄 State transition: ${newState.status} -> ${result.nextStatus}`);

        // 5. NOTIFY: If we just turned Green
        if (result.nextStatus === 'READY') {
          const notification: NotificationJob = {
            type: 'SMS',
            recipient: '+15550000000',
            templateId: 'READY_CONFIRMATION',
            data: { appointmentId: event.appointmentId, status: 'READY' }
          };
          await publishMessage(sqsClient, 'notification-queue', notification);
        }
      }
    } else {
        console.log(`[HANDLERS] Ignored unknown event type: ${body.type}`);
    }

  } catch (error) {
    console.error('[HANDLERS] Failed to process AI signal', error);
  }
}