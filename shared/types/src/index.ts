// --- Core Entities ---

export type ReadinessStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'READY' | 'AT_RISK' | 'BLOCKED';

export interface Appointment {
  id: string;
  clientName: string;
  caregiverId?: string;
  startTime: string; // ISO Date
  serviceType: string;
  location: {
    lat: number;
    lng: number;
    address: string;
  };
}

// --- SQS Message Payloads ---

// 1. Ingestion -> Readiness Engine
// Queue: readiness-evaluation-queue
export interface ReadinessEvaluationEvent {
  messageId: string;
  appointmentId: string;
  trigger: 'INGESTION' | 'UPDATE' | 'MANUAL';
  timestamp: string;
  payload?: Partial<Appointment>; // Optional context to save DB lookups
}

// 2. Readiness Engine -> Notification Service
// Queue: notification-queue
export interface NotificationJob {
  type: 'SMS' | 'EMAIL' | 'PUSH';
  recipient: string;
  templateId: string;
  data: Record<string, string>; // Variables for the template
  correlationId?: string;
}

// 3. Notification Service -> AI Interpreter
// Queue: message-interpretation-queue
export interface InboundMessageEvent {
  rawContent: string;
  sender: string;
  receivedAt: string;
  messageId: string;
}

// 4. AI Interpreter -> Readiness Engine
// Queue: readiness-signals-queue
export interface AIInterpretationSignal {
  originalMessageId: string;
  intent: 'CONFIRMATION' | 'CANCELLATION' | 'ISSUE' | 'UNKNOWN';
  confidence: number;
  extractedFields: Record<string, any>;
  summary?: string;
}

// 5. Readiness Engine -> Brief Service
// Queue: brief-generation-queue
export interface BriefGenerationJob {
  appointmentId: string;
  caregiverId: string;
  format: 'PDF' | 'TEXT';
  recipientPhone: string;
}