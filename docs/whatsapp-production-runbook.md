# WhatsApp Production Runbook (Twilio)

## 1) Core runtime configuration

Required:

```env
WHATSAPP_ENABLED=true
WHATSAPP_TRIAL_MODE=false
WHATSAPP_MAX_INBOUND_CHARS=2000
WHATSAPP_RATE_LIMIT_PER_ENDPOINT=30
WHATSAPP_STATUS_RETENTION_DAYS=30
WHATSAPP_REDACT_LOGS=true
TWILIO_ACCOUNT_SID=...
TWILIO_API_KEY_SID=...
TWILIO_API_KEY_SECRET=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+<business-number>
```

Optional emergency circuit-breaker:

```env
WHATSAPP_ALLOWLIST_NUMBERS=+1...
```

## 2) Endpoint verification and consent policy

`channel_endpoints` is the enforcement source:

- `active=true` and `verified=true` required for production inbound acceptance.
- `metadata.blocked=true` blocks inbound traffic.
- `metadata` contract:
  - `opt_in_status` (`OPTED_IN|OPTED_OUT|UNKNOWN|PENDING`)
  - `opt_in_source`
  - `opt_in_at`
  - `locale`
  - `last_delivery_status`

## 3) Incident triage

1. Signature failures:
- Check `X-Twilio-Signature` handling and `TWILIO_AUTH_TOKEN`.
- Metric to watch: `signature_invalid`.

2. Inbound accepted but no AI response:
- Query `webhook_inbox_events` for `FAILED_PROCESSING_RETRYABLE`.
- Replay:
```bash
npm run whatsapp:replay-failed -- 100
```

3. Outbound failures:
- Check `outbound_send_failed` metrics and Twilio error code in logs.
- 4xx (except 429) are non-retryable policy/data errors.
- 429/5xx are retryable and rely on queue redrive/retry behavior.

## 4) Webhook replay process

Replay pending retryable inbound events:

```bash
npm run whatsapp:replay-failed -- 100
```

Equivalent API endpoint:

```bash
curl -X POST "http://localhost:3001/testing/whatsapp/replay-failed-inbound?limit=100"
```

## 5) Retention and archival

Run periodic prune of webhook ledger:

```bash
npm run whatsapp:prune-events -- 30
```

Equivalent API endpoint:

```bash
curl -X POST "http://localhost:3001/testing/whatsapp/prune-webhook-events?retentionDays=30"
```

## 6) Monitoring and alerting

Create alerts on:

- `inbound_failed_retryable` spike.
- `inbound_ignored` spike by reason.
- `outbound_send_failed` error-rate threshold.
- SQS queue age and `incoming-messages-queue-dlq` visible messages.

For AWS DLQ alarm bootstrap, use:

```bash
DLQ_ALARM_SNS_TOPIC_ARN=<sns-topic-arn> ./scripts/setup-aws-dlq-alarms.sh
```

## 7) Secrets management policy

- Store Twilio secrets in a managed secret store for deployed environments.
- Rotation cadence:
  - API key secret: every 90 days.
  - Auth token: every 180 days or after security event.
- Rotation process:
  1. Create new key/token in Twilio.
  2. Update runtime secret store.
  3. Restart services with zero-downtime rollout.
  4. Confirm webhook signature validation + outbound send health.
  5. Revoke old key/token.
