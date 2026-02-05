#!/bin/bash
# scripts/send-test-message.sh

# Usage Check
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <queue-name> '<json-body>'"
    echo "Example: $0 readiness-evaluation-queue '{\"appointmentId\":\"123\"}'"
    exit 1
fi

QUEUE_NAME=$1
MESSAGE_BODY=$2

# Configuration
SQS_ENDPOINT="http://localhost:4566"
AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=$AWS_REGION

# 1. Get the Queue URL dynamically
QUEUE_URL=$(aws --endpoint-url=$SQS_ENDPOINT sqs get-queue-url --queue-name "$QUEUE_NAME" --output text 2>/dev/null)

if [ -z "$QUEUE_URL" ]; then
    echo "❌  Queue '$QUEUE_NAME' not found. Did you run ./scripts/setup-local.sh?"
    exit 1
fi

# 2. Send the message
echo "📧  Sending to $QUEUE_NAME..."
aws --endpoint-url=$SQS_ENDPOINT sqs send-message \
    --queue-url "$QUEUE_URL" \
    --message-body "$MESSAGE_BODY" \
    --output json

echo "" 
echo "✅  Sent."