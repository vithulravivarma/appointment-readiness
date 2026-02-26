export const QUEUES = {
  INCOMING_MESSAGES: 'incoming-messages-queue',
  READINESS_UPDATES: 'readiness-updates-queue',
  READINESS_EVALUATION: 'readiness-evaluation-queue',
  NOTIFICATION: 'notification-queue',
  BRIEF_GENERATION: 'brief-generation-queue',
  TIMESHEETS: 'timesheets-queue',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const SERVICE_PORTS = {
  APPOINTMENT_MANAGEMENT: 3001,
  READINESS_ENGINE: 3002,
  AI_INTERPRETER: 3003,
  NOTIFICATION_SERVICE: 3004,
  INGESTION_SERVICE: 3005,
  BRIEF_SERVICE: 3006,
} as const;

export type ServicePortKey = keyof typeof SERVICE_PORTS;
