-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. ENUMS
DO $$ BEGIN
    CREATE TYPE readiness_status AS ENUM (
        'NOT_STARTED', 'PENDING_CONFIRMATION', 'READY', 'AT_RISK', 'BLOCKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE check_status AS ENUM ('PENDING', 'PASS', 'FAIL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE timesheet_status AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    -- NEW: Standardized Sender Types for Chat
    CREATE TYPE sender_type_enum AS ENUM ('FAMILY', 'CAREGIVER', 'SYSTEM', 'AI_AGENT', 'COORDINATOR');
EXCEPTION WHEN duplicate_object THEN null; END $$;


-- 2. CAREGIVERS
CREATE TABLE IF NOT EXISTS caregivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), -- Keep UUIDs consistent
    aloha_caregiver_id VARCHAR(255) UNIQUE,         -- Optional if not syncing with external system yet
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    home_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. CLIENTS
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aloha_client_id VARCHAR(255) UNIQUE,
    name VARCHAR(255) NOT NULL,
    primary_phone VARCHAR(50),
    service_address TEXT,               -- ADDED: We needed this for the Seed Script error!
    service_coordinates POINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. APPOINTMENTS
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aloha_appointment_id VARCHAR(255) UNIQUE,
    client_id UUID REFERENCES clients(id),
    caregiver_id UUID REFERENCES caregivers(id),
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    service_type VARCHAR(100),
    location_address TEXT,
    aloha_status VARCHAR(50) DEFAULT 'SCHEDULED',
    -- Linking to Readiness Status directly on the appointment is helpful for fast queries
    readiness_status readiness_status DEFAULT 'NOT_STARTED', 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. READINESS_CHECKS (The Checklist)
CREATE TABLE IF NOT EXISTS readiness_checks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
    check_type VARCHAR(50) NOT NULL, 
    status check_status DEFAULT 'PENDING',
    source VARCHAR(50) DEFAULT 'SYSTEM',
    details JSONB DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(appointment_id, check_type)
);

-- 6. READINESS_EVENTS (Audit Log)
CREATE TABLE IF NOT EXISTS readiness_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id),
    event_type VARCHAR(100) NOT NULL,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. MESSAGES (UPDATED for Chat App & AI)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id),
    content TEXT NOT NULL,
    sender_type sender_type_enum NOT NULL,
    sender_id VARCHAR(255) NOT NULL,
    is_agent BOOLEAN DEFAULT FALSE,
    channel VARCHAR(50) DEFAULT 'APP',
    interpreted_signals JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ADD THIS LINE HERE:
CREATE INDEX IF NOT EXISTS idx_messages_appt ON messages(appointment_id);

-- 8. TIMESHEETS
CREATE TABLE IF NOT EXISTS timesheets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id),
    caregiver_id UUID REFERENCES caregivers(id),
    hours_worked NUMERIC(5, 2),
    status timesheet_status DEFAULT 'DRAFT',
    submitted_at TIMESTAMP WITH TIME ZONE,
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. USER AGENTS (NEW - The Digital Twins)
-- This stores the settings for the AI "Shadow" of each human.
CREATE TABLE IF NOT EXISTS user_agents (
    user_id VARCHAR(255) PRIMARY KEY, -- Links to caregiver_id or client_id
    role sender_type_enum NOT NULL,   -- 'CAREGIVER' or 'FAMILY'
    status VARCHAR(20) DEFAULT 'ACTIVE', -- 'ACTIVE' or 'PAUSED'
    paused_until TIMESTAMP WITH TIME ZONE,
    persona_settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. AUTH USERS (DEV LOGIN)
CREATE TABLE IF NOT EXISTS auth_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(120) UNIQUE NOT NULL,
    password_plaintext VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('CAREGIVER', 'FAMILY')),
    person_id UUID NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(role, person_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_users_role ON auth_users(role);

-- 11. MESSAGE IDEMPOTENCY (Queue consumer dedupe ledger)
CREATE TABLE IF NOT EXISTS message_idempotency (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    consumer_name VARCHAR(160) NOT NULL,
    queue_name VARCHAR(160) NOT NULL,
    message_id VARCHAR(255) NOT NULL,
    body_hash VARCHAR(64) NOT NULL,
    processed_outcome VARCHAR(64) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(consumer_name, queue_name, message_id, body_hash)
);

CREATE INDEX IF NOT EXISTS idx_message_idempotency_expires_at ON message_idempotency(expires_at);

-- 12. AGENT DESK THREADS (Caregiver-scoped assistant workspace)
CREATE TABLE IF NOT EXISTS agent_desk_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    caregiver_id VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 13. AGENT DESK MESSAGES (Persistent caregiver<->assistant command chat)
CREATE TABLE IF NOT EXISTS agent_desk_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID NOT NULL REFERENCES agent_desk_threads(id) ON DELETE CASCADE,
    appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
    actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('CAREGIVER', 'ASSISTANT', 'SYSTEM')),
    content TEXT NOT NULL,
    source VARCHAR(80) NOT NULL DEFAULT 'AGENT_COMMAND',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_desk_messages_thread_created_desc
    ON agent_desk_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_desk_messages_appointment_created_desc
    ON agent_desk_messages(appointment_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_desk_messages_dedupe_key
    ON agent_desk_messages(dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- 14. SCHEDULER THREADS (Caregiver-scoped scheduler workspace)
CREATE TABLE IF NOT EXISTS scheduler_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    caregiver_id VARCHAR(255) NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 15. ESCALATIONS (Tracked intervention items across Agent Desk/delegations/precheck)
CREATE TABLE IF NOT EXISTS escalations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    caregiver_id VARCHAR(255) NOT NULL,
    appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
    delegation_id VARCHAR(255),
    source VARCHAR(80) NOT NULL,
    category VARCHAR(80) NOT NULL,
    priority VARCHAR(20) NOT NULL DEFAULT 'HIGH',
    status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    summary TEXT NOT NULL,
    context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_by VARCHAR(40) NOT NULL,
    resolved_by VARCHAR(40),
    resolution_type VARCHAR(80),
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalations_caregiver_status_opened_desc
    ON escalations(caregiver_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalations_appointment_status_opened_desc
    ON escalations(appointment_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalations_status_opened_desc
    ON escalations(status, opened_at DESC);

-- 16. SCHEDULER THREAD MESSAGES (Caregiver<->Scheduler plus system escalation notices)
CREATE TABLE IF NOT EXISTS scheduler_thread_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID NOT NULL REFERENCES scheduler_threads(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('CAREGIVER', 'COORDINATOR', 'SYSTEM', 'AI_AGENT')),
    sender_id VARCHAR(255),
    content TEXT NOT NULL,
    escalation_id UUID REFERENCES escalations(id) ON DELETE SET NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_thread_messages_thread_created_desc
    ON scheduler_thread_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_thread_messages_escalation_created_desc
    ON scheduler_thread_messages(escalation_id, created_at DESC);

-- 17. CHANNEL ENDPOINTS (Demo mapping for external transport endpoints)
CREATE TABLE IF NOT EXISTS channel_endpoints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(80) NOT NULL,
    endpoint VARCHAR(120) NOT NULL,
    entity_type VARCHAR(40) NOT NULL CHECK (entity_type IN ('CLIENT', 'CAREGIVER', 'COORDINATOR')),
    entity_id UUID NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(provider, endpoint, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_endpoints_provider_endpoint
    ON channel_endpoints(provider, endpoint);

-- 18. WEBHOOK INBOX EVENTS (Inbound idempotency + status tracking)
CREATE TABLE IF NOT EXISTS webhook_inbox_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(80) NOT NULL,
    provider_message_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(80) NOT NULL DEFAULT 'INBOUND',
    status VARCHAR(80) NOT NULL DEFAULT 'RECEIVED',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_inbox_events_provider_message
    ON webhook_inbox_events(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_events_created_desc
    ON webhook_inbox_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_events_provider_created_desc
    ON webhook_inbox_events(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_events_provider_status_created_desc
    ON webhook_inbox_events(provider, status, created_at DESC);
