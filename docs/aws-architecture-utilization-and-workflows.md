# AWS Architecture Utilization and Workflow Guide

This document explains how AWS architecture is currently used in this repository, how each workflow moves through AWS-style components, and which parts are fully active versus only provisioned.

Scope:
- Code paths in `services/*`, `shared/types`, `scripts/*`, `docker-compose.yml`, and existing docs.
- Current implementation behavior (not hypothetical redesigns).

## 1. Executive Summary

The project is local-first but AWS-aligned:
- Amazon SQS patterns are the core async backbone.
- Local dev uses LocalStack SQS (`SQS_ENDPOINT=http://localhost:4566`) with AWS SDK v3 clients.
- The same queue contracts can run against real AWS SQS by removing the LocalStack endpoint override.
- Queue reliability includes long polling, retry classification, DLQ redrive policy, and idempotency controls.

Services communicate through these queue contracts:
- `incoming-messages-queue`
- `readiness-updates-queue`
- `readiness-evaluation-queue`
- `notification-queue`
- `brief-generation-queue` (consumer exists; producer currently not wired)
- `ingestion-queue` (handler exists; consumer not initialized in runtime startup)
- `timesheets-queue` (reserved constant/queue provisioning only)

## 2. AWS Components Used Today

## 2.1 SQS (Primary AWS Primitive)

SQS is used for decoupling service boundaries and async durability.

Where configured:
- `services/*/src/config.ts` (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_ENDPOINT`)
- `services/*/src/sqs.ts` (shared queue helper pattern across services)
- `services/ai-interpreter/src/handlers.ts` (custom SQS polling loop for main worker)

Core SQS behavior in code:
- Long polling (`WaitTimeSeconds`, default `20`)
- Batch receive (`MaxNumberOfMessages: 10`)
- Explicit ack/delete on success
- Retry vs non-retryable classification
- Approximate receive count parsing (`ApproximateReceiveCount`)

## 2.2 DLQs + Redrive

Local bootstrap (`scripts/setup-local.sh`) creates a DLQ per queue:
- `<queue-name>-dlq`

Default queue attributes from script:
- `VisibilityTimeout=90`
- Main queue retention: `345600` seconds (4 days)
- DLQ retention: `1209600` seconds (14 days)
- Redrive `maxReceiveCount=5`

## 2.3 CloudWatch Alarms (AWS Scripted Bootstrap)

`scripts/setup-aws-dlq-alarms.sh` creates CloudWatch alarms for each DLQ:
- Namespace: `AWS/SQS`
- Metric: `ApproximateNumberOfMessagesVisible`
- Period: `60s`
- Evaluation periods: `5`
- Threshold: `>= 1`
- Optional SNS action via `DLQ_ALARM_SNS_TOPIC_ARN`

Note:
- SNS is used only as an optional alarm action target in this repo.

## 2.4 LocalStack as AWS Emulator

`docker-compose.yml` includes LocalStack with:
- `SERVICES=sqs,s3`

Current code usage:
- SQS is actively used.
- S3 is enabled in LocalStack but not actively used by application code paths.

## 2.5 AWS SDK

The services use `@aws-sdk/client-sqs` and interact with SQS using:
- `GetQueueUrlCommand`
- `SendMessageCommand`
- `ReceiveMessageCommand`
- `DeleteMessageCommand`

## 3. Queue Topology (Current State)

| Queue | Producer(s) | Consumer(s) | Status |
|---|---|---|---|
| `incoming-messages-queue` | `appointment-management-service` (`POST /messages`) | `ai-interpreter` | Active |
| `readiness-updates-queue` | `ai-interpreter` (readiness analysis results) | `readiness-engine` | Active |
| `readiness-evaluation-queue` | `ingestion-service`, `appointment-management-service` | `readiness-engine` | Active |
| `notification-queue` | `readiness-engine`, `brief-service` | `notification-service` | Active |
| `brief-generation-queue` | No active publisher in current code | `brief-service` | Consumer active, producer missing |
| `ingestion-queue` | No active publisher in current code | `ingestion-service/src/handlers.ts` | Handler exists but not started in `index.ts` |
| `timesheets-queue` | No active publisher in current code | No consumer in current code | Reserved/provisioned only |

All above queues are created in local setup, each with its own DLQ.

## 4. Service-by-Service AWS Usage

## 4.1 appointment-management-service

AWS usage:
- Initializes SQS client.
- Publishes events to:
  - `incoming-messages-queue` on user chat messages.
  - `readiness-evaluation-queue` on lifecycle/manual/precheck reset operations.

Important endpoints that publish:
- `POST /messages` -> queue event for AI processing.
- `PUT /appointments/:id/status` -> readiness re-evaluation trigger (`trigger: LIFECYCLE`).
- `POST /appointments/:id/readiness/checks` -> readiness re-evaluation trigger (`trigger: MANUAL`).
- `POST /appointments/:id/precheck/reset` -> readiness re-evaluation trigger.
- `POST /precheck/reset-all` -> bulk readiness re-evaluation triggers.

## 4.2 ingestion-service

AWS usage:
- Publishes ingestion-triggered readiness events to `readiness-evaluation-queue`.
- Uses SQS publish from:
  - `POST /ingest/manual`
  - `POST /ingest/excel`
  - `POST /ingest/simulate/day`
  - recurring `POST /ingest/simulate/start` ticks

Note:
- `src/handlers.ts` has an `ingestion-queue` consumer placeholder, but ingestion runtime startup does not call `initializeConsumers(...)`.

## 4.3 ai-interpreter

AWS usage:
- Consumes from `incoming-messages-queue`.
- Publishes checklist signals to `readiness-updates-queue`.
- Uses custom poll loop with retry/idempotency behavior.

Main logic:
- Classifies family/caregiver/coordinator messages into readiness updates.
- Publishes `UPDATE_CHECK` events for high-confidence classifications.
- Writes AI replies to DB only when delegation/precheck gating allows.

## 4.4 readiness-engine

AWS usage:
- Consumes:
  - `readiness-evaluation-queue`
  - `readiness-updates-queue`
- Publishes notifications to `notification-queue`.

Main logic:
- Ensures checklist rows exist.
- Computes readiness transitions.
- Updates readiness status/checks.
- Kicks off precheck conversation state machine (DB events + agent settings).

## 4.5 notification-service

AWS usage:
- Consumes `notification-queue`.
- Validates payload and simulates notification send.

## 4.6 brief-service

AWS usage:
- Consumes `brief-generation-queue`.
- Generates a mock brief and forwards a notification job to `notification-queue`.

Important current-state note:
- No service currently publishes to `brief-generation-queue`, so this flow is ready but not triggered by active producers.

## 5. Message Contracts and Payload Shapes

Canonical shared contracts are defined in `shared/types/src/index.ts`.

## 5.1 Inbound Chat Event (`incoming-messages-queue`)

Published by appointment API (actual runtime payload shape):

```json
{
  "type": "NEW_MESSAGE",
  "appointmentId": "uuid",
  "text": "Client/family/caregiver message",
  "senderType": "CAREGIVER|FAMILY|COORDINATOR",
  "senderId": "uuid",
  "messageId": "uuid"
}
```

## 5.2 AI Readiness Update (`readiness-updates-queue`)

Published by AI interpreter:

```json
{
  "type": "UPDATE_CHECK",
  "appointmentId": "uuid",
  "checkType": "ACCESS_CONFIRMED|MEDS_SUPPLIES_READY|CARE_PLAN_CURRENT|CAREGIVER_MATCH_CONFIRMED",
  "status": "PASS|FAIL",
  "source": "AI_GPT4"
}
```

## 5.3 Readiness Evaluation Trigger (`readiness-evaluation-queue`)

Published by ingestion and appointment-management workflows:

```json
{
  "messageId": "manual-1741111111111",
  "appointmentId": "uuid",
  "trigger": "INGESTION|UPDATE|MANUAL|LIFECYCLE",
  "timestamp": "2026-03-03T20:15:00.000Z",
  "payload": {
    "id": "uuid"
  }
}
```

## 5.4 Notification Job (`notification-queue`)

Published by readiness-engine or brief-service:

```json
{
  "type": "SMS|EMAIL|PUSH",
  "recipient": "+15550000000",
  "templateId": "READY_CONFIRMATION|ESCALATION_ALERT|CAREGIVER_BRIEF_DELIVERY",
  "data": {
    "appointmentId": "uuid",
    "status": "READY"
  }
}
```

## 6. Reliability and Failure Handling Model

## 6.1 Retry Classification

Non-retryable errors are explicitly acknowledged to avoid poison-loop retries:
- Invalid/missing JSON payloads
- Missing required fields
- Explicit `NonRetryableMessageError`

Retryable errors are left unacknowledged:
- Message becomes visible again after visibility timeout
- Eventually redrives to DLQ per queue redrive policy

## 6.2 In-Memory Idempotency

Queue consumers maintain short-term processed-message cache keyed by:
- `queueName:messageId:bodyHash`

Defaults:
- `SQS_IDEMPOTENCY_TTL_MS=1800000` (30 min)
- `SQS_IDEMPOTENCY_MAX_KEYS=20000`

## 6.3 Persistent Idempotency (DB-backed)

`ai-interpreter` and `readiness-engine` also persist idempotency in `message_idempotency`:
- Survives process restarts
- Includes consumer name + queue name + messageId + body hash
- TTL-based expiry and background prune

Defaults:
- `SQS_PERSISTENT_IDEMPOTENCY_TTL_HOURS=168` (7 days)
- `SQS_PERSISTENT_IDEMPOTENCY_PRUNE_INTERVAL_MS=300000` (5 min)

## 7. Workflow Examples (End-to-End)

## Workflow A: Excel Ingestion to Precheck Kickoff

1. Client calls `POST /ingest/excel`.
2. Ingestion service upserts appointments in Postgres.
3. Ingestion service publishes `INGESTION` events to `readiness-evaluation-queue`.
4. Readiness engine consumes, evaluates, updates readiness state, may publish notification.
5. Readiness engine scans eligible appointments and starts system precheck conversations by:
   - writing `PRECHECK_STARTED` and `PRECHECK_PLANNER` events,
   - writing intro AI message,
   - creating/updating delegation state in `user_agents`.

Result:
- Precheck conversation is now active for later family/coordinator chat turns.

## Workflow B: Family Message to AI and Readiness Updates

1. Family sends message via `POST /messages`.
2. Appointment API stores message and publishes to `incoming-messages-queue`.
3. AI interpreter consumes message and runs readiness classification.
4. AI interpreter publishes `UPDATE_CHECK` events to `readiness-updates-queue` when confidence passes threshold.
5. Readiness engine consumes updates, updates checklist + overall readiness, may publish notification.
6. If delegation/precheck is active, AI interpreter also writes an AI reply into `messages`.

Result:
- Single incoming chat can update readiness state and optionally trigger assistant response.

## Workflow C: Manual/Lifecycle Re-evaluation

1. Coordinator/caregiver hits:
   - `PUT /appointments/:id/status`, or
   - `POST /appointments/:id/readiness/checks`.
2. Appointment API publishes `LIFECYCLE` or `MANUAL` trigger to `readiness-evaluation-queue`.
3. Readiness engine recomputes readiness and notifies if transition policy says to notify.

Result:
- Deterministic operator actions are integrated into same async readiness pipeline.

## Workflow D: Precheck Reset and Requeue

1. Operator calls:
   - `POST /appointments/:id/precheck/reset`, or
   - `POST /precheck/reset-all`.
2. Precheck markers/messages are deleted in DB.
3. Appointment API requeues readiness evaluation events.
4. Readiness engine re-runs candidate scan and re-kicks eligible prechecks.

Result:
- Recoverable precheck restart without restarting services.

## Workflow E: Notification Delivery

1. Readiness engine or brief service publishes `NotificationJob` to `notification-queue`.
2. Notification service validates payload and performs (currently simulated) send.

Result:
- Notification concerns remain decoupled from readiness/brief logic.

## Workflow F: Brief Generation Path (Prepared but Partial)

1. Brief service consumes `brief-generation-queue`.
2. Generates brief content (mocked now).
3. Publishes delivery event to `notification-queue`.

Current gap:
- No active producer publishes `BriefGenerationJob` yet.

## Workflow G: DLQ and Alerting

1. Retryable processing errors leave messages unacked.
2. After repeated receives (`maxReceiveCount`), SQS moves message to `<queue>-dlq`.
3. CloudWatch alarms on DLQ visible depth can notify SNS (if configured).

Result:
- Failures become observable and separable from normal throughput.

## 8. Configuration Reference (AWS/SQS Related)

Core connection:
- `AWS_REGION` (default `us-east-1`)
- `AWS_ACCESS_KEY_ID` (default `test` for local)
- `AWS_SECRET_ACCESS_KEY` (default `test` for local)
- `SQS_ENDPOINT` (set for LocalStack; omit for real AWS endpoint resolution)

Consumer reliability:
- `SQS_POLL_WAIT_SECONDS` (default `20`)
- `SQS_POLL_ERROR_BACKOFF_MS` (default `5000`)
- `SQS_IDEMPOTENCY_TTL_MS` (default `1800000`)
- `SQS_IDEMPOTENCY_MAX_KEYS` (default `20000`)

Persistent idempotency:
- `SQS_PERSISTENT_IDEMPOTENCY_TTL_HOURS` (default `168`)
- `SQS_PERSISTENT_IDEMPOTENCY_PRUNE_INTERVAL_MS` (default `300000`)

Workflow tuning:
- `PRECHECK_KICKOFF_BATCH_SIZE` (default `100`)
- `PRECHECK_KICKOFF_MAX_CYCLES` (default `20`)
- `READINESS_MIN_CONFIDENCE` (default `0.75`)
- `READINESS_REQUIRE_REASONING` (default `false`)
- `ASSISTANT_DELEGATION_COMPLETION_NOTIFY_V1` (default `true`)
- `ASSISTANT_DELEGATION_PROGRESS_NOTIFY_V1` (default `true`)

DLQ alarm bootstrap:
- `DLQ_ALARM_PREFIX` (default `appointment-readiness`)
- `DLQ_ALARM_SNS_TOPIC_ARN` (optional)

## 9. LocalStack to Real AWS Mapping

Local flow:
1. `docker-compose up -d`
2. `npm run migrate`
3. `npm run setup`

AWS-aligned equivalent:
- Keep same queue names and message contracts.
- Provision queues + DLQs + redrive in IaC (not included yet in this repo).
- Keep app config identical except:
  - remove/omit `SQS_ENDPOINT`,
  - replace local/test credentials with IAM role-based auth.

Optional alarm bootstrap for AWS accounts:

```bash
DLQ_ALARM_SNS_TOPIC_ARN=<sns-topic-arn> ./scripts/setup-aws-dlq-alarms.sh
```

## 10. Command-Level Workflow Examples

These are concrete command sequences that exercise the AWS-style architecture in this repository.

## 10.1 Full Local AWS-Emulated Bootstrap

```bash
docker-compose down -v
docker-compose up -d
npm run migrate
npm run setup
```

What this does:
- Starts Postgres + LocalStack.
- Applies DB schema.
- Creates all SQS queues, DLQs, and redrive settings.

## 10.2 Ingestion -> Readiness Pipeline

```bash
curl -sS -X POST http://localhost:3005/ingest/excel \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentsFile":"Appointment List_20260205031742.xlsx",
    "clientFile":"Appointment Billing Info_202602.xlsx",
    "staffFile":"Staff List_20260220110549.xlsx"
  }'
```

Expected async chain:
- ingestion-service publishes to `readiness-evaluation-queue`
- readiness-engine consumes and updates readiness/precheck state
- readiness-engine may publish to `notification-queue`
- notification-service consumes and sends simulated notifications

## 10.3 Chat -> AI -> Readiness Updates Pipeline

```bash
curl -X POST http://localhost:3001/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentId":"<appointment-uuid>",
    "content":"We have meds ready and access is confirmed."
  }'
```

Expected async chain:
- appointment-management publishes to `incoming-messages-queue`
- ai-interpreter consumes and classifies readiness signals
- ai-interpreter publishes `UPDATE_CHECK` to `readiness-updates-queue`
- readiness-engine consumes and updates checks/status

## 10.4 DLQ Alarm Bootstrap for AWS Account

```bash
DLQ_ALARM_SNS_TOPIC_ARN=<sns-topic-arn> ./scripts/setup-aws-dlq-alarms.sh
```

Expected result:
- A CloudWatch alarm is upserted per DLQ queue name.
- If SNS ARN is provided, alarm actions notify that topic.

## 10.5 Direct SQS Test Message (LocalStack)

```bash
./scripts/send-test-message.sh readiness-evaluation-queue '{"messageId":"manual-test-1","appointmentId":"<uuid>","trigger":"MANUAL","timestamp":"2026-03-03T20:15:00.000Z"}'
```

Use this to verify consumer wiring independently of API endpoints.

## 11. Gaps and Non-Utilized AWS Paths (Important)

Current factual gaps:
- `brief-generation-queue` has consumer but no active producer.
- `ingestion-queue` consumer exists in code but is not initialized by ingestion service startup.
- `timesheets-queue` is provisioned but has no producer/consumer flow in active services.
- No repo-managed AWS IaC modules yet (Terraform/CDK/CloudFormation not present for queues/resources).
- S3 is enabled in LocalStack container config but is not used in active app workflows.

Planned hardening direction is documented in `docs/ai-quality-improvement-plan.md` (ECS/Fargate, RDS tuning, Secrets Manager, autoscaling, etc.), but those deployment components are not implemented in this codebase yet.
