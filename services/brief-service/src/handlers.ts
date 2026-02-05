import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { BriefGenerationJob, NotificationJob } from '@ar/types';
import { subscribeToQueue, publishMessage } from './sqs';

export async function handleBriefGeneration(message: Message, sqsClient: SQSClient): Promise<void> {
  if (!message.Body) return;

  try {
    const job = JSON.parse(message.Body) as BriefGenerationJob;
    console.log(`[BRIEF] 📝 Generating ${job.format} brief for Appointment ${job.appointmentId}`);

    // --- MOCK GENERATION LOGIC ---
    // 1. Fetch data from DB (Simulated)
    // 2. Call OpenAI to summarize (Simulated)
    // 3. Generate PDF/Text
    
    await new Promise(r => setTimeout(r, 500)); // Simulate work
    const briefContent = "Patient requires assistance with mobility. Meds confirmed.";
    console.log(`[BRIEF] ✅ Brief generated: "${briefContent}"`);

    // --- DELIVER IT ---
    // The brief service usually sends the result back to Notification Service to deliver
    const notification: NotificationJob = {
      type: 'SMS',
      recipient: job.recipientPhone,
      templateId: 'CAREGIVER_BRIEF_DELIVERY',
      data: {
        appointmentId: job.appointmentId,
        briefPreview: briefContent
      }
    };

    console.log('[BRIEF] 🚚 Sending brief to Notification Service...');
    await publishMessage(sqsClient, 'notification-queue', notification);

  } catch (error) {
    console.error('[BRIEF] Failed to generate brief', error);
  }
}

export async function initializeConsumers(sqsClient: SQSClient): Promise<void> {
  await subscribeToQueue(sqsClient, 'brief-generation-queue', (msg) => 
    handleBriefGeneration(msg, sqsClient)
  );
}