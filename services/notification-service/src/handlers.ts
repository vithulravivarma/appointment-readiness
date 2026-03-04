import { Message } from '@aws-sdk/client-sqs';
import { NonRetryableMessageError, subscribeToQueue } from './sqs';
import { NotificationJob, QUEUES } from '@ar/types'; // <--- Shared Type

export async function handleNotification(message: Message): Promise<void> {
  if (!message.Body) {
    throw new NonRetryableMessageError('Missing message body', 'MISSING_BODY');
  }
  let job: NotificationJob;
  try {
    // Strictly typed payload
    job = JSON.parse(message.Body) as NotificationJob;
  } catch {
    throw new NonRetryableMessageError('Invalid JSON for notification event', 'INVALID_JSON');
  }
  if (!String(job.type || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing type', 'MISSING_TYPE');
  }
  if (!String(job.recipient || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing recipient', 'MISSING_RECIPIENT');
  }
  if (!String(job.templateId || '').trim()) {
    throw new NonRetryableMessageError('Notification event missing templateId', 'MISSING_TEMPLATE_ID');
  }

  console.log(`[NOTIFICATION] 📨 Processing ${job.type} for ${job.recipient}`);
  console.log(`[NOTIFICATION]    Template: ${job.templateId}`);
  console.log(`[NOTIFICATION]    Context:`, job.data);

  // Simulate sending time
  await new Promise(r => setTimeout(r, 200));
  console.log(`[NOTIFICATION] ✅ Sent successfully.`);
}

export async function initializeConsumers(sqsClient: any): Promise<void> {
  await subscribeToQueue(sqsClient, QUEUES.NOTIFICATION, handleNotification);
}
