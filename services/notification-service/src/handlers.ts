import { Message } from '@aws-sdk/client-sqs';
import { subscribeToQueue } from './sqs';
import { NotificationJob } from '@ar/types'; // <--- Shared Type

export async function handleNotification(message: Message): Promise<void> {
  if (!message.Body) return;

  try {
    // Strictly typed payload
    const job = JSON.parse(message.Body) as NotificationJob;

    console.log(`[NOTIFICATION] 📨 Processing ${job.type} for ${job.recipient}`);
    console.log(`[NOTIFICATION]    Template: ${job.templateId}`);
    console.log(`[NOTIFICATION]    Context:`, job.data);

    // Simulate sending time
    await new Promise(r => setTimeout(r, 200));
    console.log(`[NOTIFICATION] ✅ Sent successfully.`);

  } catch (error) {
    console.error('[NOTIFICATION] Error processing message', error);
  }
}

export async function initializeConsumers(sqsClient: any): Promise<void> {
  await subscribeToQueue(sqsClient, 'notification-queue', handleNotification);
}