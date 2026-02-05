import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  GetQueueUrlCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { Config } from './config';

let sqsClient: SQSClient | null = null;

export type MessageHandler = (message: Message) => Promise<void>;

/**
 * Initialize AWS SDK SQS client
 * Supports LocalStack via SQS_ENDPOINT environment variable
 */
export function initializeSQS(config: Config['sqs']): SQSClient {
  if (sqsClient) {
    return sqsClient;
  }

  const clientConfig: any = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };

  // Use LocalStack endpoint if provided (for local development)
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
  }

  sqsClient = new SQSClient(clientConfig);
  console.log('[SQS] Client initialized', {
    endpoint: config.endpoint || 'AWS default',
    region: config.region,
  });
  return sqsClient;
}

/**
 * Get queue URL by queue name
 */
async function getQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  try {
    const command = new GetQueueUrlCommand({ QueueName: queueName });
    const response = await client.send(command);
    if (!response.QueueUrl) {
      throw new Error(`Queue URL not found for queue: ${queueName}`);
    }
    return response.QueueUrl;
  } catch (error) {
    console.error(`[SQS] Failed to get queue URL for ${queueName}:`, error);
    throw error;
  }
}

/**
 * Long-poll for messages from a queue
 */
async function receiveMessages(
  client: SQSClient,
  queueUrl: string,
  waitTimeSeconds: number = 20
): Promise<Message[]> {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds, // Long polling
      MessageAttributeNames: ['All'],
    });
    const response = await client.send(command);
    return response.Messages || [];
  } catch (error) {
    console.error('[SQS] Failed to receive messages:', error);
    throw error;
  }
}

/**
 * Acknowledge (delete) a message from the queue
 */
async function acknowledgeMessage(
  client: SQSClient,
  queueUrl: string,
  receiptHandle: string
): Promise<void> {
  try {
    const command = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await client.send(command);
  } catch (error) {
    console.error('[SQS] Failed to acknowledge message:', error);
    throw error;
  }
}

/**
 * Subscribe to a queue and process messages with long-polling
 * Messages are passed to the provided handler function
 */
export async function subscribeToQueue(
  client: SQSClient,
  queueName: string,
  handler: MessageHandler
): Promise<void> {
  const queueUrl = await getQueueUrl(client, queueName);
  console.log(`[SQS] Subscribed to queue: ${queueName}`, { queueUrl });

  // Start long-polling loop
  const poll = async () => {
    try {
      const messages = await receiveMessages(client, queueUrl, 20);

      for (const message of messages) {
        if (!message.MessageId || !message.ReceiptHandle) {
          console.warn('[SQS] Received message without required fields, skipping');
          continue;
        }

        try {
          console.log('[SQS] Received message', {
            messageId: message.MessageId,
            queueName,
            bodyLength: message.Body?.length || 0,
          });

          // Pass message to handler
          await handler(message);

          // Acknowledge message after successful handling
          await acknowledgeMessage(client, queueUrl, message.ReceiptHandle);
          console.log('[SQS] Acknowledged message', {
            messageId: message.MessageId,
            queueName,
          });
        } catch (error) {
          console.error('[SQS] Error handling message', {
            messageId: message.MessageId,
            queueName,
            error: error instanceof Error ? error.message : String(error),
          });
          // Message will remain in queue and become visible again after visibility timeout
          // TODO: Implement retry logic or dead letter queue handling
        }
      }
    } catch (error) {
      console.error('[SQS] Error polling queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Continue polling
    setImmediate(poll);
  };

  // Start polling
  poll();
}

export function getSQSClient(): SQSClient | null {
  return sqsClient;
}

/**
 * Publish a message to a specific queue
 */
export async function publishMessage(
  client: SQSClient,
  queueName: string,
  body: object
): Promise<void> {
  try {
    const queueUrl = await getQueueUrl(client, queueName);
    
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
    });

    const result = await client.send(command);
    console.log(`[SQS] Published message to ${queueName}`, { messageId: result.MessageId });
  } catch (error) {
    console.error(`[SQS] Failed to publish to ${queueName}`, error);
    throw error;
  }
}