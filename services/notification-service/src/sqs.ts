import crypto from 'crypto';
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

export class NonRetryableMessageError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'NON_RETRYABLE_MESSAGE') {
    super(message);
    this.name = 'NonRetryableMessageError';
    this.code = code;
  }
}

type QueueReliabilityOptions = {
  waitTimeSeconds: number;
  pollErrorBackoffMs: number;
  idempotencyTtlMs: number;
  idempotencyMaxKeys: number;
};

const processedMessageCache = new Map<string, number>();

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function loadQueueReliabilityOptions(): QueueReliabilityOptions {
  return {
    waitTimeSeconds: parseIntEnv('SQS_POLL_WAIT_SECONDS', 20, 1, 20),
    pollErrorBackoffMs: parseIntEnv('SQS_POLL_ERROR_BACKOFF_MS', 5000, 250, 60000),
    idempotencyTtlMs: parseIntEnv('SQS_IDEMPOTENCY_TTL_MS', 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    idempotencyMaxKeys: parseIntEnv('SQS_IDEMPOTENCY_MAX_KEYS', 20000, 100, 500000),
  };
}

function nowMs(): number {
  return Date.now();
}

function cleanupProcessedMessageCache(ttlMs: number, maxKeys: number): void {
  const cutoff = nowMs() - ttlMs;
  for (const [key, seenAtMs] of processedMessageCache.entries()) {
    if (seenAtMs < cutoff) {
      processedMessageCache.delete(key);
    }
  }

  if (processedMessageCache.size <= maxKeys) return;
  const entries = Array.from(processedMessageCache.entries()).sort((a, b) => a[1] - b[1]);
  const dropCount = processedMessageCache.size - maxKeys;
  for (let i = 0; i < dropCount; i += 1) {
    processedMessageCache.delete(entries[i][0]);
  }
}

function buildIdempotencyKey(queueName: string, message: Message): string {
  const messageId = String(message.MessageId || '').trim() || 'unknown-message-id';
  const body = String(message.Body || '');
  const bodyHash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  return `${queueName}:${messageId}:${bodyHash}`;
}

function hasProcessedRecently(key: string, ttlMs: number): boolean {
  const seenAtMs = processedMessageCache.get(key);
  if (!seenAtMs) return false;
  return nowMs() - seenAtMs <= ttlMs;
}

function rememberProcessed(key: string): void {
  processedMessageCache.set(key, nowMs());
}

function parseReceiveCount(message: Message): number {
  const raw = Number(message.Attributes?.ApproximateReceiveCount || '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.trunc(raw));
}

function isNonRetryableHandlerError(error: unknown): boolean {
  if (error instanceof NonRetryableMessageError) return true;
  if (error instanceof SyntaxError) return true;
  return false;
}

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

async function receiveMessages(
  client: SQSClient,
  queueUrl: string,
  waitTimeSeconds: number,
): Promise<Message[]> {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    });
    const response = await client.send(command);
    return response.Messages || [];
  } catch (error) {
    console.error('[SQS] Failed to receive messages:', error);
    throw error;
  }
}

async function acknowledgeMessage(
  client: SQSClient,
  queueUrl: string,
  receiptHandle: string,
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
 * Subscribe to a queue and process messages with long-polling.
 * Retryable errors are left in-queue for redrive policy handling.
 */
export async function subscribeToQueue(
  client: SQSClient,
  queueName: string,
  handler: MessageHandler,
): Promise<void> {
  const queueUrl = await getQueueUrl(client, queueName);
  const options = loadQueueReliabilityOptions();
  console.log(`[SQS] Subscribed to queue: ${queueName}`, {
    queueUrl,
    reliability: {
      waitTimeSeconds: options.waitTimeSeconds,
      pollErrorBackoffMs: options.pollErrorBackoffMs,
      idempotencyTtlMs: options.idempotencyTtlMs,
      idempotencyMaxKeys: options.idempotencyMaxKeys,
    },
  });

  const poll = async () => {
    try {
      cleanupProcessedMessageCache(options.idempotencyTtlMs, options.idempotencyMaxKeys);
      const messages = await receiveMessages(client, queueUrl, options.waitTimeSeconds);

      for (const message of messages) {
        if (!message.MessageId || !message.ReceiptHandle) {
          console.warn('[SQS] Received message without required fields, skipping');
          continue;
        }

        const receiveCount = parseReceiveCount(message);
        const idempotencyKey = buildIdempotencyKey(queueName, message);

        if (hasProcessedRecently(idempotencyKey, options.idempotencyTtlMs)) {
          await acknowledgeMessage(client, queueUrl, message.ReceiptHandle);
          console.log('[SQS] Duplicate message acknowledged by idempotency cache', {
            messageId: message.MessageId,
            queueName,
            receiveCount,
          });
          continue;
        }

        try {
          console.log('[SQS] Received message', {
            messageId: message.MessageId,
            queueName,
            bodyLength: message.Body?.length || 0,
            receiveCount,
          });

          await handler(message);

          await acknowledgeMessage(client, queueUrl, message.ReceiptHandle);
          rememberProcessed(idempotencyKey);
          console.log('[SQS] Acknowledged message', {
            messageId: message.MessageId,
            queueName,
          });
        } catch (error) {
          const nonRetryable = isNonRetryableHandlerError(error);
          console.error('[SQS] Error handling message', {
            messageId: message.MessageId,
            queueName,
            receiveCount,
            retryClass: nonRetryable ? 'NON_RETRYABLE' : 'RETRYABLE',
            error: error instanceof Error ? error.message : String(error),
          });

          if (nonRetryable) {
            await acknowledgeMessage(client, queueUrl, message.ReceiptHandle);
            rememberProcessed(idempotencyKey);
            console.warn('[SQS] Dropped non-retryable message (acked to prevent poison-loop)', {
              messageId: message.MessageId,
              queueName,
              receiveCount,
            });
          }
        }
      }
    } catch (error) {
      console.error('[SQS] Error polling queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise((resolve) => setTimeout(resolve, options.pollErrorBackoffMs));
    }

    setImmediate(poll);
  };

  poll();
}

export function getSQSClient(): SQSClient | null {
  return sqsClient;
}

export async function publishMessage(
  client: SQSClient,
  queueName: string,
  body: object,
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
