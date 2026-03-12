# Precheck Logic (Current Implementation)

This document explains how precheck works end-to-end in the current codebase, including kickoff, question flow, completion, escalation, and reset/debug operations.

## What Precheck Is

Precheck is a system-managed conversation that collects critical readiness information before a scheduled appointment. It reuses the delegation structure (`user_agents.persona_settings.delegations`) but marks entries as system-managed.

Primary files:

- `services/readiness-engine/src/handlers.ts`
- `services/readiness-engine/src/repository.ts`
- `services/ai-interpreter/src/handlers.ts`
- `services/ai-interpreter/src/precheck-summary-policy.ts`
- `services/appointment-management-service/src/index.ts`
- `shared/types/src/precheck.ts`

## Checks and Profiles

### Readiness checklist definitions

Defined in `services/readiness-engine/src/repository.ts`:

- Critical:
  - `ACCESS_CONFIRMED`
  - `MEDS_SUPPLIES_READY`
  - `CARE_PLAN_CURRENT`
- Non-critical:
  - `CAREGIVER_MATCH_CONFIRMED`
  - `EXPECTATIONS_ALIGNED`
  - `VISIT_BRIEF_READY`

Precheck conversation logic focuses on the first 3 critical checks.

### Precheck profile selection

Defined in `shared/types/src/precheck.ts`.

Profiles:

1. `HOME_CARE`
2. `TRADES`
3. `CLINICAL`

Each profile supplies:

- Objective text
- Ordered prompts mapped to:
  - `ACCESS_CONFIRMED`
  - `MEDS_SUPPLIES_READY`
  - `CARE_PLAN_CURRENT`

`resolvePrecheckProfile(serviceType)` uses keyword matching; fallback is `HOME_CARE`.

## Runtime Components and Responsibilities

### `readiness-engine`

- Consumes:
  - `readiness-evaluation-queue`
  - `readiness-updates-queue`
- Ensures checklist rows exist.
- Recomputes appointment readiness status.
- Triggers precheck kickoff scan (`kickoffPendingPrecheckConversations`).

### `ai-interpreter`

- Consumes incoming chat events (`NEW_MESSAGE`).
- Runs readiness classification updates.
- Replies only when delegation or system precheck is active.
- Maintains precheck planner state in `readiness_events`.
- Completes precheck and writes escalation/completion events.

### `appointment-management-service`

- Provides manual readiness update endpoint:
  - `POST /appointments/:id/readiness/checks`
- Provides precheck reset/debug endpoints:
  - `POST /appointments/:id/precheck/reset`
  - `POST /precheck/reset-all`
  - `GET /precheck/debug-candidates`

## Precheck Kickoff Flow (System-Managed Start)

Triggered from `readiness-engine` after readiness events/updates.

### 1) Candidate scan

`findPrecheckCandidates()` selects:

1. Future appointments (`start_time > NOW()`), `SCHEDULED`, caregiver assigned.
2. Earliest upcoming appointment per client.
3. Appointment with no `PRECHECK_STARTED`.
4. Client with no other still-open precheck (started but not completed for active scheduled/in-progress appointment within a recent window).

Batch controls:

- `PRECHECK_KICKOFF_BATCH_SIZE` (default 100)
- `PRECHECK_KICKOFF_MAX_CYCLES` (default 20)

### 2) Transactional kickoff

`startPrecheckConversation()` does this in one transaction:

1. Insert `PRECHECK_STARTED` into `readiness_events` idempotently.
2. Resolve precheck profile by appointment service type.
3. Insert first AI precheck message into `messages` as `AI_AGENT`.
4. Ensure caregiver has `user_agents` row.
5. Lock `user_agents` row (`FOR UPDATE`).
6. Write system-managed delegation entry:
  - `active: true`
  - `source: 'PRECHECK_AUTOMATION'`
  - `systemManaged: true`
  - objective/questions from profile
  - `askedQuestionIndexes: [0]`
7. Seed `PRECHECK_PLANNER` event with all checklist items set `PENDING`.

If the idempotent `PRECHECK_STARTED` insert does not insert a row, kickoff returns false and no duplicate start happens.

## AI Reply Gating During Precheck

In `ai-interpreter`, replies are sent only if one of these is true:

1. Active delegation exists for appointment.
2. `isSystemPrecheckActive()` returns true:
  - appointment status is `SCHEDULED`
  - `PRECHECK_STARTED` exists
  - `PRECHECK_COMPLETED` does not exist

If neither condition is true, AI reply is skipped.

## Ongoing Precheck Conversation Logic

For each inbound FAMILY/COORDINATOR message:

1. Interpreter classifies readiness signals and publishes `UPDATE_CHECK` events.
2. Loads planner (`PRECHECK_PLANNER`) and syncs with `readiness_checks`.
3. Chooses next forced question with `pickForcedQuestion()`:
   - system-managed precheck prioritizes checklist-next question.
4. Generates short AI reply (max one question).
5. Saves reply into `messages`.
6. Marks checklist question as asked in planner when relevant.

## Completion and Escalation

When `precheckActive` and planner is complete:

1. Build final summary via `buildPrecheckCompletionSummary(planner)`.
2. Decide whether summary can be written into delegation record:
   - allowed for system-managed/no conflicting caregiver-managed delegation.
   - skipped for caregiver-managed manual delegations.
3. If unresolved failures remain:
   - insert `PRECHECK_ESCALATED` event
   - insert `SYSTEM` message in `messages` instructing caregiver follow-up.
4. Insert `PRECHECK_COMPLETED` idempotently with outcome:
   - `RESOLVED` or `ESCALATED`
5. If summary write is allowed, append to `summaryHistory` and mark delegation inactive with summary metadata.

Important behavior:

- Precheck completion does not overwrite caregiver-managed manual delegation summaries.
- If manual delegation overrides active precheck, interruption is marked with `PRECHECK_INTERRUPTED`.
- After manual delegation stop, precheck recovery can occur:
  - critical `FAIL` present: no restart, escalate immediately,
  - no critical `FAIL` but incomplete: resume/restart with a graceful client-facing notice.

## Reset and Replay Operations

### Single appointment reset

`POST /appointments/:id/precheck/reset`

Actions:

1. Deletes `PRECHECK_STARTED`, `PRECHECK_COMPLETED`, `PRECHECK_PLANNER` events for that appointment.
2. Deletes AI precheck-intro/system-like precheck messages matching known content patterns.
3. Publishes readiness evaluation trigger (`trigger: MANUAL`) so readiness-engine can re-evaluate and re-kickoff if eligible.

### Global reset

`POST /precheck/reset-all`

Actions:

1. Deletes all precheck lifecycle/planner events globally.
2. Deletes matching AI precheck messages globally.
3. Re-selects next eligible upcoming appointment per client.
4. Requeues readiness evaluation for each selected appointment.

### Candidate visibility

`GET /precheck/debug-candidates?limit=<n>`

Returns current appointments that satisfy kickoff eligibility logic.

## Data You Should Inspect While Debugging

### 1) Readiness events timeline

For one appointment, verify expected sequence:

1. `PRECHECK_STARTED`
2. `PRECHECK_PLANNER`
3. optional `PRECHECK_ESCALATED`
4. `PRECHECK_COMPLETED`

### 2) Planner state

Inspect latest `PRECHECK_PLANNER` event details and item statuses.

### 3) Delegation entry in `user_agents`

Confirm flags for precheck-managed conversation:

- `source: PRECHECK_AUTOMATION`
- `systemManaged: true`
- `active` transitions to false on completion (when summary write path is allowed)

### 4) Chat transcript

In `messages`, ensure:

- AI precheck opener was inserted.
- AI follow-up questions are not duplicated excessively.
- escalation/system message exists when unresolved failures remain.

### 5) Idempotency table

`message_idempotency` confirms duplicate queue messages are safely ignored.

## Key Constraints to Remember

1. Precheck kickoff is appointment-future and scheduled-only.
2. At most one open precheck per client at a time.
3. Precheck uses delegation data shape but is system-managed.
4. Manual caregiver delegation data is protected from precheck summary overwrite.
5. Reset endpoints clear markers and rely on requeued readiness evaluation to restart flow.
