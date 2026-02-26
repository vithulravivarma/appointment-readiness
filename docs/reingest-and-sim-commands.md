# Reingest + Day Simulation Commands

Run all commands from repo root: `/Users/vithulravivarma/appointment-readiness`.

## 1) Clean appointment-related data (all appointments)

This removes all appointments and appointment-linked rows, then clears stale delegation/summary references from `user_agents`.

```bash
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "BEGIN; DELETE FROM messages WHERE appointment_id IS NOT NULL; DELETE FROM readiness_events WHERE appointment_id IS NOT NULL; DELETE FROM readiness_checks WHERE appointment_id IS NOT NULL; DELETE FROM timesheets WHERE appointment_id IS NOT NULL; DELETE FROM appointments; UPDATE user_agents SET persona_settings = (COALESCE(persona_settings, '{}'::jsonb) - 'delegations' - 'summaryHistory'); COMMIT;"
```

Optional quick verify:

```bash
docker exec appointment-readiness-postgres psql -U postgres -d postgres -c "SELECT COUNT(*) AS appointments FROM appointments;"
```

## 2) Reingest all data from spreadsheets

```bash
curl -X POST http://localhost:3005/ingest/excel \
  -H "Content-Type: application/json" \
  -d '{
    "appointmentsFile":"Appointment List_20260205031742.xlsx",
    "clientFile":"Appointment Billing Info_202602.xlsx",
    "staffFile":"Staff List_20260220110549.xlsx"
  }'
```

## 3) Run day simulations again

Each command below simulates a day with `subsetSize=5`.

### 2026-02-22

```bash
curl -X POST http://localhost:3005/ingest/simulate/day \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-22","subsetSize":5}'
```

### 2026-02-24

```bash
curl -X POST http://localhost:3005/ingest/simulate/day \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-24","subsetSize":5}'
```

### 2026-02-25

```bash
curl -X POST http://localhost:3005/ingest/simulate/day \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-25","subsetSize":5}'
```

### 2026-02-27

```bash
curl -X POST http://localhost:3005/ingest/simulate/day \
  -H "Content-Type: application/json" \
  -d '{"simulatedToday":"2026-02-27","subsetSize":5}'
```

## 4) Optional precheck refresh after reingest/simulation

```bash
curl -X POST http://localhost:3001/precheck/reset-all
```
