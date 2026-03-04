# Appointment Readiness Architecture

## System Overview
The repository is a local-first monorepo for appointment readiness operations with:
- PostgreSQL for source-of-truth data.
- LocalStack SQS for async service orchestration.
- TypeScript microservices under `services/*`.
- Expo mobile app under `mobile-app`.

## Canonical Data Model
- Readiness status is stored on `appointments.readiness_status`.
- Readiness checks are stored in `readiness_checks`.
- Chat history is stored in `messages`.
- Digital twin state is stored in `user_agents`.
- Agent Desk caregiver command chat is stored in `agent_desk_threads` + `agent_desk_messages`.

There is no separate `appointment_readiness` table in the active schema.

## Service Roles
- `appointment-management-service`:
  - Primary REST API for mobile/web clients.
  - Reads appointments/readiness and writes chat messages.
  - Publishes user chat events to SQS.
- `ai-interpreter`:
  - Consumes chat events.
  - Produces AI responses and readiness check updates.
  - Responds only when an active caregiver delegation window exists for the appointment.
- `readiness-engine`:
  - Consumes readiness triggers and AI check updates.
  - Evaluates overall readiness state transitions.
  - Publishes notification jobs.
- `notification-service`:
  - Consumes notification jobs (currently simulated delivery).
- `brief-service`:
  - Consumes brief-generation jobs and forwards delivery notifications.
- `ingestion-service`:
  - Ingests/creates appointments and emits readiness-evaluation events.

## Canonical Queue Contracts
Use these names as the current standard:
- `incoming-messages-queue`: appointment API -> AI interpreter
- `readiness-updates-queue`: AI interpreter -> readiness engine
- `readiness-evaluation-queue`: ingestion/manual trigger -> readiness engine
- `notification-queue`: readiness/brief services -> notification service
- `brief-generation-queue`: readiness engine -> brief service

## Default Local Ports
- Appointment API: `3001`
- Readiness engine: `3002`
- AI interpreter: `3003`
- Notification service: `3004`
- Ingestion service: `3005`
- Brief service: `3006`
- Expo dev server: default Expo port

## Frontend Integration Notes
- `mobile-app/constants/Config.js` should match the appointment API port.
- Android emulator uses `10.0.2.2`; iOS simulator uses `localhost`.

## Styling System
- The mobile app uses `mobile-app/design/system.ts` as a shared design system.
- Core screens consume shared tokens for:
  - color palette,
  - spacing scale,
  - radius scale,
  - typography scale,
  - card/shadow primitives.
- Navigation theme in `mobile-app/app/_layout.tsx` is aligned to the same tokens.

## Delegation Workflow
- Caregiver starts delegation from `Agent Desk` (`mobile-app/app/agent-command-center.tsx`).
- Delegation is time-boxed and scoped per appointment with:
  - objective,
  - question checklist,
  - duration.
- Delegation state is persisted in `user_agents.persona_settings.delegations`.
- AI replies in chat only while delegation is active and not expired.
- Caregiver ends delegation from `Agent Desk`; backend generates a final summary and stores it with the delegation record.
- Summaries are appended to `persona_settings.summaryHistory` so they persist across future delegations.
- System-only delegation notes are hidden from client/family chat views.
- `Agent Desk` shows active delegations and recent summaries across appointments.
- Agent Desk free-form caregiver/assistant chat persists across sessions via `GET /agents/:userId/chat/history`.

## Ingestion Workflow (Current + Future)
- `ingestion-service` now supports a source abstraction (`IngestionSource`) so ingestion transport can change without rewriting mapping logic.
- Current implementation uses `ExcelIngestionSource` and joins:
  - `Appointment List_20260205031742.xlsx` (scheduling rows),
  - `Appointment Billing Info_202602.xlsx` (client source-of-truth for IDs/name/address),
  - `Staff List_20260220110549.xlsx` (optional caregiver enrichment by name match).
- Primary join key is `Appointment ID`; fallback client matching is by normalized client name when the appointment row has no billing row.
- Trigger endpoint: `POST /ingest/excel` on ingestion service.
- Future Aloha API integration should implement another `IngestionSource` using the same output contract (`IngestionPayload[]`).

## Auth + Test Accounts
- `auth_users` is the local auth table for basic multi-user testing.
- Accounts are auto-provisioned during ingestion for:
  - caregivers (`role=CAREGIVER`),
  - patients/families (`role=FAMILY`).
- Appointment API exposes:
  - `GET /auth/accounts` for selecting test users,
  - `POST /auth/login` for token issuance.
- Default local test password is `demo123` (intentionally simple for dev).
