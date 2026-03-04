# Reingest + Day Simulation Runbook (Local)

Run all commands from repo root:
`/Users/vithulravivarma/appointment-readiness`

## 0) Full restart (infra + schema + queues + services)

Use this sequence when you want a reliable reset before reingest/sim.

```bash
# Stop infra from prior runs
npm run infra:down

# Start Postgres + LocalStack
npm run infra:up

# Apply latest schema (required for agent_desk_* tables)
npm run migrate

# Create SQS queues + DLQs (uses corrected RedrivePolicy syntax)
npm run setup
```

Then start services:

```bash
./start-all.sh
```

If services are already running, you can skip `./start-all.sh`.

## 1) Verify core health endpoints

```bash
curl -sf http://localhost:3001/health && echo " appointment-management OK"
curl -sf http://localhost:3002/health && echo " readiness-engine OK"
curl -sf http://localhost:3003/health && echo " ai-interpreter OK"
curl -sf http://localhost:3004/health && echo " notification-service OK"
curl -sf http://localhost:3005/health && echo " ingestion-service OK"
curl -sf http://localhost:3006/health && echo " brief-service OK"
```

## 2) Wipe persisted data before reingest

Use one of the two options below.

### Option A: Full DB data wipe (keeps containers running)

This wipes all persisted app/runtime data from Postgres, including:
- appointment + readiness + timesheet + chat data
- agent desk threads/messages
- delegation/summary/assistant state (`user_agents`)
- dev login accounts (`auth_users`)
- idempotency ledger (`message_idempotency`)
- base roster entities (`clients`, `caregivers`)

```bash
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "TRUNCATE TABLE agent_desk_messages, agent_desk_threads, message_idempotency, messages, readiness_events, readiness_checks, timesheets, appointments, auth_users, user_agents, clients, caregivers RESTART IDENTITY CASCADE;"
```

Quick verify:

```bash
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "SELECT 'appointments' AS table, COUNT(*) FROM appointments UNION ALL SELECT 'messages', COUNT(*) FROM messages UNION ALL SELECT 'agent_desk_messages', COUNT(*) FROM agent_desk_messages UNION ALL SELECT 'user_agents', COUNT(*) FROM user_agents UNION ALL SELECT 'auth_users', COUNT(*) FROM auth_users;"
```

### Option B: Nuclear reset (wipe DB + LocalStack volumes)

This clears all persisted Docker volume state, including Postgres and LocalStack.

```bash
docker-compose down -v
docker-compose up -d
npm run migrate
npm run setup
```

## 3) Reingest all data from spreadsheets

```bash
curl -sS -X POST http://localhost:3005/ingest/excel \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentsFile":"Appointment List_20260205031742.xlsx",
    "clientFile":"Appointment Billing Info_202602.xlsx",
    "staffFile":"Staff List_20260220110549.xlsx"
  }' | jq
```

## 4) Run day simulations

Each command below simulates a day with `subsetSize=5`.

```bash
curl -sS -X POST http://localhost:3005/ingest/simulate/day -H "Content-Type: application/json" -d '{"simulatedToday":"2026-03-03","subsetSize":5}' | jq
curl -sS -X POST http://localhost:3005/ingest/simulate/day -H "Content-Type: application/json" -d '{"simulatedToday":"2026-03-04","subsetSize":5}' | jq
curl -sS -X POST http://localhost:3005/ingest/simulate/day -H "Content-Type: application/json" -d '{"simulatedToday":"2026-03-05","subsetSize":5}' | jq
curl -sS -X POST http://localhost:3005/ingest/simulate/day -H "Content-Type: application/json" -d '{"simulatedToday":"2026-03-06","subsetSize":5}' | jq
```

## 5) Optional follow-up commands

Reset precheck state after reingest/sim:

```bash
curl -sS -X POST http://localhost:3001/precheck/reset-all | jq
```

Backfill old assistant history into `agent_desk_messages` (optional):

```bash
npm run backfill:agent-desk
```

End-to-end smoke test (optional):

```bash
npm run smoke
```

## Troubleshooting

If you see:
`relation "agent_desk_threads" does not exist`

Run:

```bash
npm run migrate
```

If you see AWS CLI `--attributes`/`RedrivePolicy` parse errors, do not use ad-hoc queue commands; run:

```bash
npm run setup
```
