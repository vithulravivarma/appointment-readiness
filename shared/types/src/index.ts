// --- Core Entities ---
export * from './platform';
export * from './precheck';

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
  trigger: 'INGESTION' | 'UPDATE' | 'MANUAL' | 'LIFECYCLE';
  timestamp: string;
  payload?: Partial<Appointment>; // Optional context to save DB lookups
}

// 2. Readiness Engine -> Notification Service
// Queue: notification-queue
export interface NotificationJob {
  type: 'SMS' | 'EMAIL' | 'PUSH' | 'WHATSAPP';
  recipient: string;
  templateId: string;
  data: Record<string, string>; // Variables for the template
  correlationId?: string;
  provider?: 'TWILIO_WHATSAPP';
  fromEndpoint?: string;
  toEndpoint?: string;
  conversationRef?: string;
  externalMessageId?: string;
}

// 3. Appointment API -> AI Interpreter
// Queue: incoming-messages-queue
export interface InboundMessageEvent {
  type?: 'NEW_MESSAGE';
  appointmentId?: string;
  text?: string;
  senderType?: 'FAMILY' | 'CAREGIVER' | 'COORDINATOR' | 'SYSTEM' | 'AI_AGENT';
  senderId?: string;
  messageId?: string;
  channel?: 'APP' | 'WHATSAPP';
  provider?: 'TWILIO_WHATSAPP';
  fromEndpoint?: string;
  toEndpoint?: string;
  externalMessageId?: string;
  rawContent?: string;
  sender?: string;
  receivedAt?: string;
}

// 4. AI Interpreter -> Readiness Engine
// Queue: readiness-updates-queue
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
