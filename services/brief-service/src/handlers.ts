import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { BriefGenerationJob, NotificationJob, QUEUES } from '@ar/types';
import { NonRetryableMessageError, subscribeToQueue, publishMessage } from './sqs';

export async function handleBriefGeneration(message: Message, sqsClient: SQSClient): Promise<void> {
  if (!message.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }
  let job: BriefGenerationJob;
  try {
    job = JSON.parse(message.Body) as BriefGenerationJob;
  } catch {
    throw new NonRetryableMessageError('Invalid JSON for brief generation event', 'INVALID_JSON');
  }
  if (!String(job.appointmentId || '').trim()) {
    throw new NonRetryableMessageError('Brief generation event missing appointmentId', 'MISSING_APPOINTMENT_ID');
  }
  if (!String(job.recipientPhone || '').trim()) {
    throw new NonRetryableMessageError('Brief generation event missing recipientPhone', 'MISSING_RECIPIENT_PHONE');
  }

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
  await publishMessage(sqsClient, QUEUES.NOTIFICATION, notification);
}

export async function initializeConsumers(sqsClient: SQSClient): Promise<void> {
  await subscribeToQueue(sqsClient, QUEUES.BRIEF_GENERATION, (msg) => 
    handleBriefGeneration(msg, sqsClient)
  );
}
