#!/bin/bash

# 1. Start Docker Containers (Database & LocalStack)
echo "🐳 Starting Docker Containers..."
docker-compose up -d
echo "✅ Docker is running in the background."

# 2. WAIT for LocalStack to wake up (Crucial!)
echo "⏳ Waiting 10 seconds for LocalStack to initialize..."
sleep 10

# 3. Create the Queues (The Infrastructure)
echo "📢 Creating ALL SQS Queues..."

# --- A. The "Foundational" Queues (From your original design) ---
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name incoming-messages-queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name readiness-updates-queue

# --- B. The "Service-Specific" Queues (From your error logs) ---
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name brief-generation-queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name notification-queue
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name readiness-evaluation-queue

# Function to open a new terminal tab and run a command
open_tab() {
    local title="$1"
    local command="$2"
    
    osascript -e "tell application \"Terminal\" to do script \"echo '$title'; cd '$PWD'; $command\""
}

# 2. Launch Backend Services
echo "🚀 Launching Services in new tabs..."

# Service A: Appointment Management (Port 3001)
open_tab "Appointment Service" "PORT=3001 npm run dev --prefix services/appointment-management-service"

# Service B: Readiness Engine (Port 3002)
open_tab "Readiness Engine" "PORT=3002 npm run dev --prefix services/readiness-engine"

# Service C: AI Interpreter (Port 3003)
open_tab "AI Brain" "PORT=3003 npm run dev --prefix services/ai-interpreter"

# Service D: Notification Service (Port 3004)
open_tab "Notification Service" "PORT=3004 npm run dev --prefix services/notification-service"

# Service E: Ingestion Service (Port 3005)
open_tab "Ingestion Service" "PORT=3005 npm run dev --prefix services/ingestion-service"

# Service F: Brief Service (Port 3006)
open_tab "Brief Service" "PORT=3006 npm run dev --prefix services/brief-service"

# 3. Launch Frontend (Expo)
echo "📱 Launching Mobile App..."
open_tab "📱 Mobile App" "npm start --prefix mobile-app"

echo "✨ All systems go! Check your Terminal tabs."
