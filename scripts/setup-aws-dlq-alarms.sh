#!/bin/bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ALARM_PREFIX="${DLQ_ALARM_PREFIX:-appointment-readiness}"
SNS_TOPIC_ARN="${DLQ_ALARM_SNS_TOPIC_ARN:-}"

QUEUES=(
  "readiness-evaluation-queue"
  "notification-queue"
  "brief-generation-queue"
  "incoming-messages-queue"
  "readiness-updates-queue"
  "ingestion-queue"
  "timesheets-queue"
)

for queue_name in "${QUEUES[@]}"; do
  dlq_name="${queue_name}-dlq"
  alarm_name="${ALARM_PREFIX}-${queue_name}-dlq-visible"

  base_args=(
    --region "$AWS_REGION"
    cloudwatch put-metric-alarm
    --alarm-name "$alarm_name"
    --alarm-description "DLQ has visible messages: ${dlq_name}"
    --namespace "AWS/SQS"
    --metric-name "ApproximateNumberOfMessagesVisible"
    --dimensions "Name=QueueName,Value=${dlq_name}"
    --statistic "Maximum"
    --period 60
    --evaluation-periods 5
    --threshold 1
    --comparison-operator "GreaterThanOrEqualToThreshold"
    --treat-missing-data "notBreaching"
  )

  if [ -n "$SNS_TOPIC_ARN" ]; then
    aws "${base_args[@]}" --alarm-actions "$SNS_TOPIC_ARN"
  else
    aws "${base_args[@]}" --actions-enabled false
  fi

  echo "✅ Upserted DLQ alarm: $alarm_name"
done

if [ -z "$SNS_TOPIC_ARN" ]; then
  echo "ℹ️  No SNS topic configured. Set DLQ_ALARM_SNS_TOPIC_ARN to attach notifications."
fi
