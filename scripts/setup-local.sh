#!/bin/bash
# scripts/setup-local.sh

# Configuration
SQS_ENDPOINT="http://localhost:4566"
AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=$AWS_REGION

# The list of queues to create
QUEUES=(
  "readiness-evaluation-queue"
  "notification-queue"
  "brief-generation-queue"
  "message-interpretation-queue"
  "readiness-signals-queue"
  "timesheets-queue"
)

echo "🚀  Initializing LocalStack SQS Queues..."

# 1. Wait for LocalStack to be ready (The Robust Fix)
echo "⏳  Waiting for LocalStack to be ready at $SQS_ENDPOINT..."
# We try to list queues. If this command succeeds (exit code 0), SQS is up.
# We silence the output (> /dev/null) because we don't care about the result yet.
until aws --endpoint-url=$SQS_ENDPOINT sqs list-queues > /dev/null 2>&1; do
  echo "    ...waiting for SQS to respond..."
  sleep 2
done
echo "✅  LocalStack SQS is up."

# 2. Create Queues
for QUEUE_NAME in "${QUEUES[@]}"; do
  aws --endpoint-url=$SQS_ENDPOINT sqs create-queue --queue-name "$QUEUE_NAME" > /dev/null 2>&1
  
  if [ $? -eq 0 ]; then
    echo "   ✅  Created/Verified '$QUEUE_NAME'"
  else
    echo "   ❌  Failed to create '$QUEUE_NAME'"
  fi
done

echo "🎉  SQS Setup Complete."