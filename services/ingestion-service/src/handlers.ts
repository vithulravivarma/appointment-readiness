import { Message } from '@aws-sdk/client-sqs';
import { subscribeToQueue, MessageHandler } from './sqs';

/**
 * Placeholder handler for ingestion messages
 * Does NOT implement ingestion logic or mutate state
 * No database writes or state changes - placeholder only
 */
export async function handleIngestion(message: Message): Promise<void> {
  let appointmentId: string | undefined;
  let correlationId: string | undefined;

  // Parse message body if present
  if (message.Body) {
    try {
      const body = JSON.parse(message.Body);
      appointmentId = body.appointmentId;
      correlationId = body.correlationId;
    } catch (error) {
      // Body is not JSON, check message attributes
      console.log('[HANDLER] Message body is not JSON, checking attributes');
    }
  }

  // Check message attributes for appointmentId and correlationId
  if (message.MessageAttributes) {
    if (!appointmentId && message.MessageAttributes.appointmentId?.StringValue) {
      appointmentId = message.MessageAttributes.appointmentId.StringValue;
    }
    if (!correlationId && message.MessageAttributes.correlationId?.StringValue) {
      correlationId = message.MessageAttributes.correlationId.StringValue;
    }
  }

  // Log appointmentId and correlationId if present
  const logData: Record<string, any> = {
    messageId: message.MessageId,
  };

  if (appointmentId) {
    logData.appointmentId = appointmentId;
  }

  if (correlationId) {
    logData.correlationId = correlationId;
  }

  console.log('[HANDLER] Processing ingestion message', logData);

  // Simulate successful processing
  // No database writes, no state changes - placeholder only
  console.log('[HANDLER] Successfully processed ingestion (placeholder)');
}

/**
 * Initialize SQS consumers for ingestion-service
 */
export async function initializeConsumers(sqsClient: ReturnType<typeof import('./sqs').initializeSQS>): Promise<void> {
  // Subscribe to ingestion-queue
  await subscribeToQueue(sqsClient, 'ingestion-queue', handleIngestion);
}
