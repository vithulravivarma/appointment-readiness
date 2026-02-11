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