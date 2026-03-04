# Appointment Readiness
Appointment readiness + caregiver delegation system with:
- A multi-service backend (Node/TypeScript + Postgres + LocalStack/SQS)
- An Expo mobile app
- AI-assisted readiness updates and delegated chat workflows

## Architecture At A Glance
- `services/appointment-management-service` (port `3001`): auth, appointments, chat, delegation APIs.
- `services/readiness-engine` (port `3002`): readiness scoring + precheck kickoff automation.
- `services/ai-interpreter` (port `3003`): AI analysis of chat, sends readiness check updates.
- `services/notification-service` (port `3004`): notification queue consumer.
- `services/ingestion-service` (port `3005`): Excel/manual ingestion + recurring simulated ingestion.
- `services/brief-service` (port `3006`): brief generation queue consumer.
- `mobile-app`: caregiver/family UI.

Routing/intent flow details:
- `docs/agent-routing-architecture.md`

### Precheck Profiles (Swappable Components)
- Profile definitions live in `shared/types/src/precheck.ts`.
- Current built-in profiles:
  - `HOME_CARE`
  - `TRADES`
  - `CLINICAL`
- Both readiness kickoff and AI follow-up use the same resolved profile by `appointments.service_type`.
- To support a new vertical, add a new profile object (questions + signals + objective) and include matching keywords.

## Prerequisites
- Node.js 20+ and npm
- Docker + Docker Compose
- AWS CLI (for queue setup script)
- macOS Terminal if using `start-all.sh` (it uses `osascript`)

## Environment
Root `.env` is shared by services. Minimum required values:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_ENDPOINT=http://localhost:4566
OPENAI_API_KEY=...
GOOGLE_MAPS_API_KEY=...
```

## Install
```bash
npm install
```

## Bring Up Infrastructure
```bash
npm run infra:up
npm run setup
npm run migrate
```

What this does:
- Starts Postgres and LocalStack
- Creates SQS queues + per-queue DLQs with redrive defaults (`scripts/setup-local.sh`)
- Applies `migrations/schema.sql`

For AWS environments, you can also bootstrap DLQ depth alarms:
```bash
DLQ_ALARM_SNS_TOPIC_ARN=<sns-topic-arn> ./scripts/setup-aws-dlq-alarms.sh
```

## Start The System

### Option A: One-command local startup (macOS)
```bash
./start-all.sh
```
Starts infra, queues, all backend services, and Expo app in separate Terminal tabs.

### Option B: Manual startup (cross-platform)
Run each in separate terminals:

```bash
PORT=3001 npm run dev --prefix services/appointment-management-service
PORT=3002 npm run dev --prefix services/readiness-engine
PORT=3003 npm run dev --prefix services/ai-interpreter
PORT=3004 npm run dev --prefix services/notification-service
PORT=3005 npm run dev --prefix services/ingestion-service
PORT=3006 npm run dev --prefix services/brief-service
npm start --prefix mobile-app
```

## Health Checks
```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
curl http://localhost:3004/health
curl http://localhost:3005/health
curl http://localhost:3006/health
```

## Data Ingestion

### 1) Ingest from Excel sample files
```bash
curl -X POST http://localhost:3005/ingest/excel \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentsFile":"Appointment List_20260205031742.xlsx",
    "clientFile":"Appointment Billing Info_202602.xlsx",
    "staffFile":"Staff List_20260220110549.xlsx"
  }'
```

`billingFile` remains supported as a legacy alias for `clientFile`.

### 2) Manual single ingest
```bash
curl -X POST http://localhost:3005/ingest/manual \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 3) Simulate next-day recurring ingestion

Single simulated day:
```bash
curl -X POST http://localhost:3005/ingest/simulate/day \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-18","subsetSize":3}'
```

Start recurring simulation:
```bash
curl -X POST http://localhost:3005/ingest/simulate/start \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-18","subsetSize":3,"intervalMs":60000}'
```

Status/stop:
```bash
curl http://localhost:3005/ingest/simulate/status
curl -X POST http://localhost:3005/ingest/simulate/stop
```

## Auth + API Smoke Test

### 1) Get seeded accounts
```bash
curl http://localhost:3001/auth/accounts
```

### 2) Login (demo password is `demo123`)
```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<username>","password":"demo123"}'
```
Save returned `token`.

### 3) List appointments for logged-in user
```bash
curl http://localhost:3001/appointments \
  -H "Authorization: Bearer <token>"
```

### 4) Update appointment lifecycle status
```bash
curl -X PUT http://localhost:3001/appointments/<appointment-uuid>/status \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_PROGRESS"}'
```
Allowed statuses: `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.

### 5) Reset and re-trigger precheck for one appointment
```bash
curl -X POST http://localhost:3001/appointments/<appointment-uuid>/precheck/reset
```
This deletes `PRECHECK_*` markers for that appointment and immediately re-queues readiness evaluation so precheck kickoff can run again.

### 6) Reset precheck globally and re-trigger latest scheduled appointment per client
```bash
curl -X POST http://localhost:3001/precheck/reset-all
```
This clears all `PRECHECK_*` markers/messages and re-queues readiness evaluation for the **next upcoming** `SCHEDULED` appointment for each client.

### 7) Debug current auto-precheck candidates
```bash
curl "http://localhost:3001/precheck/debug-candidates?limit=50"
```
Returns the appointments currently eligible for auto-precheck kickoff, including `appointmentId`, `clientName`, `appointmentDate`, and `appointmentStartTime`.
Eligibility rule includes a buffer: later appointments are held until earlier scheduled/in-progress appointments for that client are at least 3 hours past `end_time`.

### 8) Debug one appointment readiness flow end-to-end
```bash
curl "http://localhost:3001/appointments/<appointment-uuid>/debug/readiness-flow"
```
Returns appointment state, readiness checks, recent readiness events, recent messages, and caregiver delegation payload for that appointment.

### 9) Test utility: delete all appointments on a specific date
```bash
curl -X DELETE http://localhost:3001/testing/appointments/by-date/2026-02-19
```
This is a destructive testing endpoint for local/dev use. It removes appointments on that date and related rows (messages/readiness events/checks/timesheets), and cleans matching delegation references from `user_agents`.

## Readiness + Chat + Delegation Test Flow

### 1) Send a message (caregiver/family)
```bash
curl -X POST http://localhost:3001/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentId":"<appointment-uuid>",
    "content":"We have meds ready and entry code confirmed."
  }'
```

### 2) Check readiness state
```bash
curl http://localhost:3001/appointments/<appointment-uuid>/readiness
```

### 3) Start delegated AI handoff
```bash
curl -X POST http://localhost:3001/agents/<caregiver-user-id>/delegations/start \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentId":"<appointment-uuid>",
    "objective":"Keep family updated and collect blockers.",
    "durationMinutes":30,
    "questions":["Any access issues?","Are medications/supplies ready?"]
  }'
```

### 4) Free-form command desk action (auto-answer or auto-start delegation)
```bash
curl -X POST http://localhost:3001/agents/<caregiver-user-id>/command \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentId":"<appointment-uuid>",
    "command":"Start checking whether they have food in the fridge."
  }'
```
This endpoint can:
- answer schedule/time-between-appointments questions,
- answer route and drive-time questions using Google Maps (home-to-visit, visit-to-home, and between visits),
- search recent conversation history for that client across appointments (with scan limits),
- look up access-code evidence from conversation history,
- auto-start a delegation window using the same safeguards as manual `/delegations/start`.
Optional tuning: include `searchLimits` in request body, e.g. `{"searchLimits":{"appointmentLimit":6,"messageLimit":180,"snippetLimit":4}}`.
Optional maps override: include `homeAddress` in the request body when caregiver home address is not stored.

### 5) Get handoff summary without stopping
```bash
curl -X POST http://localhost:3001/agents/<caregiver-user-id>/delegations/<appointment-uuid>/handoff-summary
```
If delegation is no longer active but a prior summary exists, this can return the latest stored summary with `resumedFromHistory: true`.

### 6) Stop delegation and persist summary
```bash
curl -X POST http://localhost:3001/agents/<caregiver-user-id>/delegations/<appointment-uuid>/stop
```

### 7) View summary history
```bash
curl http://localhost:3001/agents/<caregiver-user-id>/summaries
```

Notes:
- Automated pre-readiness now appears as an active delegation in Agent Desk for the caregiver.
- When pre-readiness checklist finishes:
  - if all critical checks are resolved, delegation auto-completes with summary
  - if unresolved checks remain, delegation auto-completes and escalates to caregiver with summary

## Tests
Root tests:
```bash
npm test
```

Type-check a service:
```bash
npm run type-check --prefix services/readiness-engine
```

End-to-end smoke flow:
```bash
./scripts/e2e-smoke.sh
npm run smoke
```

## Common Troubleshooting
- `QueueDoesNotExist`: run `npm run setup` again.
- DB schema mismatch: run `npm run migrate`.
- AI not responding: check `OPENAI_API_KEY`, then `ai-interpreter` logs.
- No appointments visible: ingest data first via `/ingest/excel` or `/ingest/manual`.
- Mobile app cannot reach API on Android emulator: uses `10.0.2.2` in `mobile-app/constants/Config.js`.

## Important Notes
- Demo auth is intentionally simple (`auth_users.password_plaintext = demo123`) for local testing.
- Current `.env` should not contain production secrets. Rotate any exposed keys.
