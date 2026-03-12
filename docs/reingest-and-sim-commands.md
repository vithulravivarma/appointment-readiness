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

## 6) Twilio WhatsApp Sandbox demo prep

Create/update a WhatsApp endpoint mapping for a demo client:

```bash
curl -sS -X POST http://localhost:3001/testing/channel-endpoints/upsert \
  -H "Content-Type: application/json" \
  -d '{
    "provider":"twilio_whatsapp",
    "endpoint":"+15551234567",
    "entityType":"CLIENT",
    "entityId":"<client-uuid>",
    "verified":true
  }' | jq
```

List current endpoint mappings:

```bash
curl -sS http://localhost:3001/testing/channel-endpoints | jq
```

Webhook endpoints to configure in Twilio console:

- Inbound: `POST https://<public-tunnel-host>/webhooks/twilio/whatsapp/inbound`
- Status: `POST https://<public-tunnel-host>/webhooks/twilio/whatsapp/status`

Demo-only env flags to verify before running:

```bash
echo "$WHATSAPP_ENABLED $WHATSAPP_TRIAL_MODE $TWILIO_ACCOUNT_SID $TWILIO_WHATSAPP_FROM"
echo "$WHATSAPP_ALLOWLIST_NUMBERS"
echo "$WHATSAPP_MAX_INBOUND_CHARS $WHATSAPP_RATE_LIMIT_PER_ENDPOINT $WHATSAPP_STATUS_RETENTION_DAYS $WHATSAPP_REDACT_LOGS"
```

### Quick Cloudflare tunnel (simple mode)

Use this if you do not want a named/stable tunnel setup.

```bash
# 1) Start tunnel to appointment-management-service
cloudflared tunnel --url http://localhost:3001
```

Copy the generated `https://<something>.trycloudflare.com` URL and set Twilio Sandbox webhooks:

- Inbound: `POST https://<that-url>/webhooks/twilio/whatsapp/inbound`
- Status: `POST https://<that-url>/webhooks/twilio/whatsapp/status`

Important behavior with quick mode:

- Each time you restart `cloudflared tunnel --url ...`, the URL usually changes.
- If URL changes, update both Twilio webhook URLs again.
- You do **not** need to redo DB phone mapping or endpoint mapping unless DB was reset.

Quick verification after tunnel start:

```bash
curl -sf http://localhost:3001/health && echo " appointment-management OK"
```

### Reusable: Yashwanth Gandham phone + endpoint mapping (after DB reset)

Use this exact sequence to re-apply mapping after a DB wipe/reingest.

```bash
# 1) Find client UUID
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "SELECT id::text AS client_id, name, primary_phone FROM clients WHERE lower(name) LIKE '%gandham%';"

# 2) Set client phone (replace UUID if different from output above)
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "UPDATE clients SET primary_phone = '+14252819495', updated_at = NOW() WHERE id = '5c32a790-e769-464d-8149-3a0cd9adb30a'::uuid RETURNING id::text AS client_id, name, primary_phone;"

# 3) Upsert twilio_whatsapp endpoint mapping
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "INSERT INTO channel_endpoints (provider, endpoint, entity_type, entity_id, active, verified, metadata, updated_at) VALUES ('twilio_whatsapp', '+14252819495', 'CLIENT', '5c32a790-e769-464d-8149-3a0cd9adb30a'::uuid, true, true, '{}'::jsonb, NOW()) ON CONFLICT (provider, endpoint, entity_type, entity_id) DO UPDATE SET active = EXCLUDED.active, verified = EXCLUDED.verified, updated_at = NOW() RETURNING provider, endpoint, entity_type, entity_id::text, active, verified;"

# 4) Verify mapping
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "SELECT provider, endpoint, entity_type, entity_id::text, active, verified FROM channel_endpoints WHERE provider = 'twilio_whatsapp' AND endpoint = '+14252819495';"
```

If the UUID changes after a future reingest, use the new UUID from step 1 in steps 2 and 3.

### Production WhatsApp controls + recovery

Use this for post-sandbox/paid rollout checks.

```bash
# Recommended production flags
echo "$WHATSAPP_ENABLED $WHATSAPP_TRIAL_MODE"
echo "$WHATSAPP_MAX_INBOUND_CHARS $WHATSAPP_RATE_LIMIT_PER_ENDPOINT $WHATSAPP_STATUS_RETENTION_DAYS $WHATSAPP_REDACT_LOGS"
```

Replay retryable inbound failures (`FAILED_PROCESSING_RETRYABLE`):

```bash
npm run whatsapp:replay-failed -- 100
```

Prune old webhook ledger rows:

```bash
npm run whatsapp:prune-events -- 30
```

Optional API operations for the same tasks:

```bash
curl -sS -X POST "http://localhost:3001/testing/whatsapp/replay-failed-inbound?limit=100" | jq
curl -sS -X POST "http://localhost:3001/testing/whatsapp/prune-webhook-events?retentionDays=30" | jq
```

Query endpoint consent/delivery metadata:

```bash
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "SELECT provider, endpoint, verified, active, metadata->>'opt_in_status' AS opt_in_status, metadata->>'opt_in_source' AS opt_in_source, metadata->>'opt_in_at' AS opt_in_at, metadata->>'locale' AS locale, metadata->>'last_delivery_status' AS last_delivery_status FROM channel_endpoints WHERE provider='twilio_whatsapp' ORDER BY updated_at DESC;"
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
