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

-- 2. CAREGIVERS [cite: 105]
CREATE TABLE IF NOT EXISTS caregivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aloha_caregiver_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL, -- Needed for SMS
    email VARCHAR(255),
    home_address TEXT,          -- [cite: 108]
    home_coordinates POINT,     -- For Route Service [cite: 206]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. CLIENTS (New - Critical for Family Notifications)
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aloha_client_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    primary_phone VARCHAR(50) NOT NULL, -- The destination for family SMS 
    service_address TEXT,               -- The default appointment location
    service_coordinates POINT,          -- For Route Service
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. APPOINTMENTS [cite: 67]
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aloha_appointment_id VARCHAR(255) UNIQUE NOT NULL,
    client_id UUID REFERENCES clients(id),         -- 
    caregiver_id UUID REFERENCES caregivers(id),   -- [cite: 71]
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,  -- [cite: 72]
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    service_type VARCHAR(100),
    location_address TEXT,                         -- [cite: 73]
    location_coordinates POINT,                    -- For Route Service
    aloha_status VARCHAR(50),                      -- [cite: 74]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. APPOINTMENT_READINESS [cite: 75]
CREATE TABLE IF NOT EXISTS appointment_readiness (
    appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
    status readiness_status DEFAULT 'NOT_STARTED', -- [cite: 78]
    risk_score INTEGER DEFAULT 0,                  -- [cite: 79]
    last_evaluated_at TIMESTAMP WITH TIME ZONE,    -- [cite: 80]
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. READINESS_CHECKS [cite: 81]
CREATE TABLE IF NOT EXISTS readiness_checks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
    check_type VARCHAR(50) NOT NULL, -- [cite: 85]
    status check_status DEFAULT 'PENDING',
    source VARCHAR(50) DEFAULT 'SYSTEM', -- [cite: 87]
    details JSONB DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(appointment_id, check_type)
);

-- 7. MESSAGES [cite: 96]
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id),
    channel VARCHAR(50) DEFAULT 'SMS',    -- [cite: 100]
    direction VARCHAR(20) NOT NULL,       -- [cite: 101]
    sender_role VARCHAR(50),              -- 'FAMILY', 'CAREGIVER', 'SYSTEM'
    raw_content TEXT,                     -- [cite: 102]
    interpreted_signals JSONB,            -- [cite: 103] (AI Output)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. READINESS_EVENTS [cite: 89] (Audit Log)
CREATE TABLE IF NOT EXISTS readiness_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id),
    event_type VARCHAR(100) NOT NULL,     -- [cite: 93]
    details JSONB,                        -- [cite: 94]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. TIMESHEETS  (Restored)
CREATE TABLE IF NOT EXISTS timesheets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id UUID REFERENCES appointments(id), -- [cite: 113]
    caregiver_id UUID REFERENCES caregivers(id),     -- [cite: 114]
    hours_worked NUMERIC(5, 2),                      -- [cite: 115]
    status timesheet_status DEFAULT 'DRAFT',         -- [cite: 116]
    submitted_at TIMESTAMP WITH TIME ZONE,           -- [cite: 117]
    approved_at TIMESTAMP WITH TIME ZONE,            -- [cite: 118]
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);