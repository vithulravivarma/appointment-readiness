#!/bin/bash
# scripts/setup-local.sh
set -euo pipefail

SQS_ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SQS_VISIBILITY_TIMEOUT_SECONDS="${SQS_VISIBILITY_TIMEOUT_SECONDS:-90}"
SQS_MESSAGE_RETENTION_SECONDS="${SQS_MESSAGE_RETENTION_SECONDS:-345600}"
SQS_DLQ_MESSAGE_RETENTION_SECONDS="${SQS_DLQ_MESSAGE_RETENTION_SECONDS:-1209600}"
SQS_DLQ_MAX_RECEIVE_COUNT="${SQS_DLQ_MAX_RECEIVE_COUNT:-5}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$AWS_REGION"

QUEUES=(
  "readiness-evaluation-queue"
  "notification-queue"
  "brief-generation-queue"
  "incoming-messages-queue"
  "readiness-updates-queue"
  "ingestion-queue"
  "timesheets-queue"
)

create_queue_if_missing() {
  local queue_name="$1"
  aws --endpoint-url="$SQS_ENDPOINT" sqs create-queue --queue-name "$queue_name" > /dev/null 2>&1
}

get_queue_url() {
  local queue_name="$1"
  aws --endpoint-url="$SQS_ENDPOINT" sqs get-queue-url --queue-name "$queue_name" --query QueueUrl --output text
}

get_queue_arn() {
  local queue_url="$1"
  aws --endpoint-url="$SQS_ENDPOINT" sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names QueueArn \
    --query "Attributes.QueueArn" \
    --output text
}

echo "🚀 Initializing LocalStack SQS queues with DLQ redrive defaults..."
echo "⏳ Waiting for LocalStack SQS at $SQS_ENDPOINT..."
until aws --endpoint-url="$SQS_ENDPOINT" sqs list-queues > /dev/null 2>&1; do
  echo "   ...waiting for SQS to respond..."
  sleep 2
done
echo "✅ LocalStack SQS is ready."

for queue_name in "${QUEUES[@]}"; do
  dlq_name="${queue_name}-dlq"

  create_queue_if_missing "$dlq_name"
  dlq_url="$(get_queue_url "$dlq_name")"
  aws --endpoint-url="$SQS_ENDPOINT" sqs set-queue-attributes \
    --queue-url "$dlq_url" \
    --attributes MessageRetentionPeriod="$SQS_DLQ_MESSAGE_RETENTION_SECONDS" \
    > /dev/null
  dlq_arn="$(get_queue_arn "$dlq_url")"

  create_queue_if_missing "$queue_name"
  queue_url="$(get_queue_url "$queue_name")"
  aws --endpoint-url="$SQS_ENDPOINT" sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes \
      VisibilityTimeout="$SQS_VISIBILITY_TIMEOUT_SECONDS",MessageRetentionPeriod="$SQS_MESSAGE_RETENTION_SECONDS" \
    > /dev/null

  redrive_policy="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$dlq_arn" "$SQS_DLQ_MAX_RECEIVE_COUNT")"
  redrive_policy_escaped="${redrive_policy//\"/\\\"}"
  aws --endpoint-url="$SQS_ENDPOINT" sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes "{\"RedrivePolicy\":\"$redrive_policy_escaped\"}" \
    > /dev/null

  echo "✅ $queue_name (DLQ: $dlq_name, maxReceiveCount: $SQS_DLQ_MAX_RECEIVE_COUNT)"
done

echo "🎉 SQS setup complete."
