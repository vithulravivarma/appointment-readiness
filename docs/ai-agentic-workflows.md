# AI + Agentic Workflow Deep Dive

This document explains every current AI/agentic workflow in this repository, with step-by-step execution paths and debugging guidance.

UI note: Agent Desk delegation start is now chat-driven only in `mobile-app/app/agent-command-center.tsx` (the old manual objective/questions form was removed from the screen). Backend delegation start logic and APIs still exist.

## Scope

This covers all active AI/agentic behavior as of March 2026:

1. Caregiver Agent Desk command routing and tool orchestration in `appointment-management-service`.
2. AI interpreter behavior for family/coordinator chat messages in `ai-interpreter`.
3. System-managed precheck delegation bootstrap in `readiness-engine`.
4. Agent state persistence, dedupe/idempotency, and message history paths used by those flows.

It does not cover speculative/planned tools in docs unless they are wired in code.

## Twilio Sandbox 5-Minute Pre-Demo Checklist

Run this right before demo time:

1. Sandbox join:
- From each demo phone, send the Twilio Sandbox join phrase to the Twilio sandbox WhatsApp number.
- Confirm each phone receives the "joined sandbox" confirmation reply.
2. Webhook health:
- Ensure your tunnel URL is live.
- Twilio inbound webhook: `POST /webhooks/twilio/whatsapp/inbound`.
- Twilio status webhook: `POST /webhooks/twilio/whatsapp/status`.
3. Service health:
- Confirm `appointment-management-service`, `ai-interpreter`, and `notification-service` are healthy.
4. Env sanity:
- `WHATSAPP_ENABLED=true`
- `WHATSAPP_TRIAL_MODE=true`
- `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` are loaded.
5. End-to-end probe:
- Send one WhatsApp text from a joined/allowlisted phone.
- Verify inbound row in `messages` has `channel='WHATSAPP'`.
- Verify AI reply is delivered back to WhatsApp.

## Twilio WhatsApp Production Checklist

1. Production flags:
- `WHATSAPP_ENABLED=true`
- `WHATSAPP_TRIAL_MODE=false`
- `WHATSAPP_MAX_INBOUND_CHARS` set (default `2000`)
- `WHATSAPP_RATE_LIMIT_PER_ENDPOINT` set (default `30` / minute)
- `WHATSAPP_STATUS_RETENTION_DAYS` set (default `30`)
- `WHATSAPP_REDACT_LOGS=true`
2. Endpoint mapping policy:
- `channel_endpoints.active=true`
- `channel_endpoints.verified=true` (required in production mode)
- Use `metadata` fields for consent/audit (`opt_in_status`, `opt_in_source`, `opt_in_at`, `locale`, `last_delivery_status`).
3. Recovery + retention:
- Replay retryable failures: `npm run whatsapp:replay-failed -- <limit>`
- Prune old webhook events: `npm run whatsapp:prune-events -- <days>`
4. Monitoring signals:
- `signature_invalid`
- `inbound_processed`
- `inbound_ignored` (reason-tagged)
- `inbound_failed_retryable`
- `outbound_send_success`
- `outbound_send_failed`
- `outbound_status_updated`

## Source Map

Primary files:

- `services/appointment-management-service/src/index.ts`
- `services/appointment-management-service/src/delegation-intent-policy.ts`
- `services/appointment-management-service/src/delegation-context-compiler.ts`
- `services/appointment-management-service/src/turn-signal-policy.ts`
- `services/appointment-management-service/src/router-contract-policy.ts`
- `services/ai-interpreter/src/handlers.ts`
- `services/ai-interpreter/src/delegation-policy.ts`
- `services/ai-interpreter/src/delegation-completion-policy.ts`
- `services/ai-interpreter/src/precheck-summary-policy.ts`
- `services/readiness-engine/src/handlers.ts`
- `migrations/schema.sql`
- `mobile-app/app/agent-command-center.tsx`

## High-Level Runtime Topology

1. A user sends a chat message with `POST /messages`.
2. `appointment-management-service` writes to `messages` and publishes `NEW_MESSAGE` to `incoming-messages-queue`.
3. `ai-interpreter` consumes the queue event.
4. `ai-interpreter` does two jobs:
- Job A: classify readiness signals and publish `UPDATE_CHECK` events to `readiness-updates-queue`.
- Job B: if sender is FAMILY/COORDINATOR and delegation or precheck is active, generate AI chat reply and persist it to `messages`.
5. `readiness-engine` consumes readiness updates, updates readiness status, and may kick off precheck automation for future appointments.

Separately:

1. Caregiver sends command to `POST /agents/:userId/command`.
2. Agent Desk router decides `RESPOND`, `ASK_FOLLOW_UP`, or `USE_TOOL`.
3. Tool execution may read schedule/messages/maps, start delegation, or ask confirmation/follow-up.
4. Agent Desk state is persisted in `user_agents.persona_settings.assistant` and optionally in `agent_desk_messages`.

## Data Model Used by Agentic Paths

Core tables:

- `messages`: all appointment chat (caregiver/family/coordinator/AI_AGENT/SYSTEM).
- `user_agents`: per-user digital twin state and settings (`persona_settings` JSONB).
- `agent_desk_threads` and `agent_desk_messages`: caregiver Agent Desk conversational history and delegated update feed.
- `readiness_checks`: readiness check statuses.
- `readiness_events`: precheck lifecycle and planner snapshots.
- `message_idempotency`: persistent SQS dedupe ledger.

Important `persona_settings` subtrees:

- `assistant.history`: recent caregiver/assistant command turns.
- `assistant.pending`: unresolved follow-up context.
- `assistant.memory`: inferred appointment/client/date context.
- `delegations[appointmentId]`: active or historical delegation windows.
- `summaryHistory`: stored delegation/precheck summaries.

## Workflow A: Caregiver Agent Desk Command Pipeline

Entrypoint: `POST /agents/:userId/command` in `services/appointment-management-service/src/index.ts`.

### A1) Request intake and state load

1. Authorizes caregiver/coordinator access to that agent workspace.
2. Reads `command`, optional `appointmentId`, optional `durationMinutes`, optional `forceStart`.
3. Loads `user_agents.persona_settings` and constructs `assistantState`.
4. Appends caregiver turn to assistant history.
5. Persists caregiver message to `agent_desk_messages` with dedupe key when Agent Desk persistence is enabled.

### A2) Turn-signal analysis

`analyzeCaregiverTurnWithLLM()` runs:

1. Deterministic fast path first via `detectDeterministicTurnSignals()`:
- cancellation phrases (`cancel`, `never mind`, etc.),
- execute-pending confirmations (`yes`, `go ahead`, etc.) when pending exists.
2. If deterministic is not confident and API key exists, LLM classifies:
- `isGreeting`,
- `isAcknowledgement`,
- `isCancellation`,
- `mergeWithPending`,
- `executePending`.

Early exits:

1. Greeting and no pending -> short greeting response.
2. Acknowledgement and no pending -> short “what next?” response.
3. Cancellation with pending -> clears pending and confirms cancellation.

### A3) Build planning command and context

1. If `mergeWithPending`, builds planning command from pending base command + bounded clarification history (up to 4 recent clarifications) + latest clarification.
2. Stores date hints (`today`, `tomorrow`, explicit date) into assistant memory.
3. Loads caregiver appointments (`schedule.get_all` trace event).
4. Resolves explicit context detection using both LLM and deterministic heuristics.

### A4) Planner decision

Primary planner path is LLM-first when enabled:

- `ASSISTANT_AI_FIRST_INTENT_V1=true`
- `OPENAI_API_KEY` set

Planner returns contract fields like:

- `action`: `RESPOND | ASK_FOLLOW_UP | USE_TOOL`
- `tool`: `SCHEDULE_DAY | MAPS_ROUTE | CLIENT_INFO | START_DELEGATION`
- optional slots, hints, response style.

Fallback chain:

1. Deterministic planner fallback (`maybeDeterministicFallbackPlannerDecision`).
2. If still empty and pending + execute/merge, build pending tool decision.
3. Else default to `RESPOND`.

Optional legacy recovery hop exists only when:

- `ASSISTANT_SINGLE_ROUTER_V1=false`
- `ASSISTANT_ENABLE_LEGACY_RECOVERY_V0=true`

### A5) Router normalization + safety overrides

1. `applyRouterContractDefaults()` normalizes required slots and response style.
2. Explicit delegation directive safety override can force `START_DELEGATION`.
3. START_DELEGATION always goes through contact confirmation gate unless already in pending confirm and user explicitly executes pending.

Contact confirmation prompt:

- “I can contact the client/family to find out the missing details. Do you want me to reach out now?”

### A6) ASK_FOLLOW_UP path

1. Attempts to infer tool from decision or pending state.
2. Avoids repeat follow-up loops using `isRepeatedAssistantPrompt()`.
3. If repeated prompt detected, falls back to direct non-tool response.
4. Otherwise sets pending state type:
- `MAPS_HOME_ADDRESS`
- `CLIENT_INFO_CONTEXT`
- `DELEGATION_CONTEXT`
- `DELEGATION_TARGET_CONTEXT`

### A7) RESPOND path

1. Generates direct reply with LLM fallback prompt.
2. Sanitizes non-tool responses to prevent false “action already executed” claims.
3. Runs missing-info policy (`ANSWER_FROM_KNOWN_INFO` vs `ACQUIRE_MISSING_INFO`).
4. If missing-info confidence >= `0.55`, asks delegation confirmation instead of ending with dead-end answer.

### A8) SCHEDULE_DAY tool path

1. Resolves business date from command/memory.
2. Loads day appointments from DB.
3. Builds structured schedule summary with gaps and next/first visit wording.
4. Clears pending, updates memory date hint, returns `mode=ANSWERED`.

### A9) MAPS_ROUTE tool path

1. Resolves business date.
2. Builds map plan mode with LLM classifier:
- day route,
- between visits,
- day route with return home,
- home->client,
- client->home.
3. If required home leg but no home address, asks follow-up and sets `MAPS_HOME_ADDRESS` pending.
4. Executes Google Distance Matrix calls.
5. Returns route legs and summary; adds context disclosure when appointment was inferred.

### A10) CLIENT_INFO tool path

1. Resolves target appointment (LLM + deterministic fallback).
2. If no target, asks follow-up and sets `CLIENT_INFO_CONTEXT` pending.
3. Looks up scoped messages for that client across appointment history.
4. Selects relevant evidence rows (LLM selector + deterministic fallback).
5. Synthesizes concise answer from evidence.
6. Applies delegation-state claim safety.
7. Runs missing-info policy; may route to delegation confirmation if unknown facts remain and caregiver intent implies acquisition.

### A11) START_DELEGATION tool path

1. If pending target context unresolved, asks for visit selection.
2. Resolves target appointment.
3. Compiles delegation context via `compileDelegationContext()` when feature flag enabled:
- objective,
- delegation type (`FACT_CHECK | LOGISTICS | OPEN_ENDED`),
- primary/optional question items,
- context packet with known/missing facts and evidence.
4. Starts window with `startDelegationWindow()`:
- validates appointment ownership,
- blocks on failed critical readiness checks unless `forceStart=true`,
- writes active delegation into `user_agents.persona_settings.delegations`,
- sends kickoff AI message into `messages` table,
- records asked question indexes.
5. Returns `mode=DELEGATION_STARTED`.

Operational note:

- Caregiver-facing Agent Desk now initiates delegation through `/agents/:userId/command` (tool route), not a dedicated manual form.
- Direct `POST /agents/:userId/delegations/start` is deprecated/blocked; delegation start must flow through `/agents/:userId/command` so contact confirmation is enforced.
- Backend delegation lifecycle remains available for stop/history paths (`/agents/:userId/delegations/:appointmentId/stop`, summaries, state persistence).

Critical checks enforced before normal delegation start:

- `ACCESS_CONFIRMED`
- `MEDS_SUPPLIES_READY`
- `CARE_PLAN_CURRENT`

### A12) State persistence and concurrency

`persistAssistantState()` behavior:

1. Writes assistant state back to `user_agents.persona_settings.assistant`.
2. Uses optimistic concurrency with metadata version compare-and-swap.
3. Retries once on version conflict.
4. Persists only assistant-state delta turns into `agent_desk_messages` (dedupe key based).

### A13) Delegation stop path

Endpoint: `POST /agents/:userId/delegations/:appointmentId/stop`

1. Validates delegation exists.
2. If already inactive with summary, returns existing.
3. Builds delegation summary from chat window (`messages` between startedAt and endedAt):
- extracts key points (LLM + fallback),
- formats caregiver-readable summary via `buildCaregiverDelegationSummary()`.
4. Marks delegation inactive and appends summary to `summaryHistory`.
5. If this was caregiver-managed manual delegation that interrupted precheck:
- If any critical check is `FAIL`, skip precheck restart and emit escalation/completion events.
- Else if critical checks are incomplete, resume precheck gracefully (resume remaining checks when prior precheck responses existed; otherwise restart from first question).

## Workflow B: AI Interpreter (Family/Coordinator Chat Agent)

Entrypoint is SQS consumer in `services/ai-interpreter/src/handlers.ts`.

### B1) Queue receive and idempotency

1. Polls `incoming-messages-queue`.
2. Uses in-memory idempotency cache (TTL + max-size pruning).
3. Uses persistent idempotency (`message_idempotency`) keyed by consumer+queue+messageId+bodyHash.
4. Non-retryable malformed payloads are acknowledged and marked dropped to avoid poison loops.

### B2) Process incoming chat event

For each `NEW_MESSAGE` event:

1. Validates `appointmentId`, `senderType`, `text`.
2. Ignores `SYSTEM` and `AI_AGENT` senders (loop prevention).
3. Runs readiness analysis for human senders (`CAREGIVER`, `FAMILY`, `COORDINATOR`).
4. Runs conversational AI reply only for `FAMILY` and `COORDINATOR` senders.

### B3) Readiness analysis sub-flow

1. Builds recent conversation context.
2. LLM classifies message into readiness categories:
- `ACCESS_CONFIRMED`
- `MEDS_SUPPLIES_READY`
- `CARE_PLAN_CURRENT`
- `CAREGIVER_MATCH_CONFIRMED`
3. Filters by confidence and optional reasoning requirement.
4. Publishes `UPDATE_CHECK` events to `readiness-updates-queue`.

### B4) Caregiver agent reply gate

Before generating a family/coordinator-facing AI reply:

1. Loads appointment caregiver and client context.
2. Loads caregiver `user_agents` status/settings.
3. Resolves delegation state for this appointment.
4. Expires stale delegations (active but ended by time).
5. Checks `isSystemPrecheckActive()` from readiness events.
6. If neither delegation nor precheck is active, no AI reply is sent.

### B5) Planner/checklist/delegation synthesis

1. Loads and hydrates checklist planner (`PRECHECK_PLANNER`).
2. Applies readiness updates to planner and syncs with `readiness_checks` table.
3. Normalizes delegation question set and primary/optional indexes.
4. Assesses delegation questions against latest client message with LLM:
- `answered`,
- `askable`,
- `confidence`.
5. Computes completion state via `evaluateDelegationCompletion()`.
6. Chooses forced next question using `pickForcedQuestion()`:
- manual delegation questions prioritized over checklist,
- system-managed precheck prioritizes checklist question.

### B6) Reply generation

1. For FACT_CHECK delegations with no forced question, uses deterministic ack text.
2. Otherwise calls OpenAI with strict system prompt:
- max one question,
- at most 2 short sentences,
- no repeated/already answered questions,
- logistics-only scope.
3. Persists reply as `AI_AGENT` in `messages`.

### B7) Delegation progress and completion notifications

If delegation is active and caregiver-managed:

1. Generates completion update when all required askable items resolved (completion-only; no incremental progress updates).
2. Writes completion update to `agent_desk_messages` with dedupe key:
- `delegation-complete:<appointmentId>:<startedAt>`
3. Persists delegation progress fields in `user_agents`:
- `askedQuestionIndexes`
- `resolvedQuestionIndexes`
- `progressNotifiedIndexes`
- `completionNotifiedAt`

Completion message format:

- Completion updates written to Agent Desk are generated as natural-language caregiver summaries (LLM-first with deterministic fallback), not a rigid question-by-question answer checklist.

Important: completion notification does not auto-stop manual delegation.

### B8) Precheck completion path

If system precheck is active and checklist is complete:

1. Builds concise precheck summary (`buildPrecheckCompletionSummary`).
2. Writes summary into delegation record only when safe:
- allowed for system-managed/no existing entry,
- skipped for caregiver-managed manual delegations.
3. Appends summary to `summaryHistory`.
4. Writes escalation events/messages when unresolved checks remain.
5. Writes `PRECHECK_COMPLETED` event idempotently.

## Workflow C: System-Managed Precheck Bootstrapping

Implemented in `services/readiness-engine/src/handlers.ts`.

### C1) Trigger points

`kickoffPendingPrecheckConversations()` runs after readiness evaluation/update events.

### C2) Candidate selection

Finds next eligible scheduled appointment per client where:

1. No prior `PRECHECK_STARTED` for that appointment.
2. No other still-open precheck for same client.
3. Appointment is future and has caregiver assigned.

### C3) Precheck start transaction

`startPrecheckConversation()` performs transactional setup:

1. Inserts `PRECHECK_STARTED` readiness event (idempotent style).
2. Sends initial AI precheck question to `messages` as `AI_AGENT`.
3. Ensures caregiver has `user_agents` row and locks it.
4. Creates system-managed delegation entry in persona settings:
- `source: PRECHECK_AUTOMATION`
- `systemManaged: true`
- objective/questions from resolved precheck profile.
5. Seeds `PRECHECK_PLANNER` event.

This means precheck is represented using the same delegation structure as manual delegation, but marked system-managed.

## Workflow D: Twilio WhatsApp (Production-Hardened Path)

Entrypoints in `appointment-management-service`:

- `POST /webhooks/twilio/whatsapp/inbound`
- `POST /webhooks/twilio/whatsapp/status`

### D1) Inbound webhook handling

1. Verifies Twilio signature from `X-Twilio-Signature`.
2. Uses `webhook_inbox_events` for idempotency on `(provider, provider_message_id)`.
3. Normalizes `From`/`To` WhatsApp endpoints to E.164 format.
4. Enforces allowlist when configured (`WHATSAPP_ALLOWLIST_NUMBERS`) to support trial mode and emergency traffic brakes.
5. Rejects media (`NumMedia > 0`) and oversized payloads (`WHATSAPP_MAX_INBOUND_CHARS`).
6. Enforces endpoint rate limits (`WHATSAPP_RATE_LIMIT_PER_ENDPOINT`) and records `IGNORED_RATE_LIMITED`.
7. Resolves sender endpoint via `channel_endpoints` (`provider='twilio_whatsapp', entity_type='CLIENT'`).
8. In production mode (`WHATSAPP_TRIAL_MODE=false`), requires `verified=true`; otherwise records `IGNORED_UNVERIFIED_ENDPOINT`.
9. Blocks inactive/blocked endpoints with `IGNORED_BLOCKED_ENDPOINT`.
10. Resolves operational appointment context for that client.
11. Writes inbound chat row to `messages` with `sender_type='FAMILY'` and `channel='WHATSAPP'`.
12. Publishes enriched `NEW_MESSAGE` event to `incoming-messages-queue` with `channel/provider/fromEndpoint/toEndpoint/externalMessageId`.
13. If queue publish fails, stores `FAILED_PROCESSING_RETRYABLE` and returns Twilio-friendly 2xx to avoid duplicate provider retries.

### D2) AI interpreter propagation

1. `ai-interpreter` parses optional channel/provider metadata from incoming events.
2. Existing readiness + delegation logic remains unchanged.
3. AI reply row is written to `messages` with the same channel (`APP` or `WHATSAPP`).
4. If channel is `WHATSAPP`, interpreter publishes a `NotificationJob` with `type='WHATSAPP'` to `notification-queue`.

### D3) Outbound WhatsApp delivery

1. `notification-service` handles `NotificationJob.type='WHATSAPP'`.
2. Sends via Twilio Messages API (`from=TWILIO_WHATSAPP_FROM`, `to=whatsapp:+E164`, `Body=<reply text>`).
3. Enforces outbound text length guardrail and classifies Twilio failures into retryable/non-retryable classes.
4. Stores outbound provider metadata in `webhook_inbox_events` with provider `twilio_whatsapp_outbound`.
5. Twilio status callbacks update outbound status through `POST /webhooks/twilio/whatsapp/status`.
6. Status callback updates `channel_endpoints.metadata.last_delivery_status` for endpoint-level observability.

### D4) Recovery and retention operations

1. Retryable inbound failures (`FAILED_PROCESSING_RETRYABLE`) are replayable via:
- `npm run whatsapp:replay-failed -- <limit>`
- or `POST /testing/whatsapp/replay-failed-inbound`
2. Webhook ledger retention is managed via:
- `npm run whatsapp:prune-events -- <days>`
- or `POST /testing/whatsapp/prune-webhook-events`

## Twilio Paid Plan Request Packet

1. Account and sender onboarding:
- Upgrade account from trial.
- WhatsApp Business sender onboarding for dedicated business number.
- Confirmation of sender display name and sender status timeline.
2. Credentials and webhook assets:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`
- `TWILIO_AUTH_TOKEN`
- Production `TWILIO_WHATSAPP_FROM`
- Registered inbound + status webhook callback URLs.
3. Commercial + policy asks:
- Pricing and monthly cost estimate at expected volume.
- Conversation category/template requirements for business-initiated messages.
- Rate limits, quality controls, and support escalation path.
- Data residency/compliance documents needed by your org.
4. Internal prep before requesting:
- Legal business name, website/domain.
- Use-case summary and sample messages.
- Estimated monthly message volume and target countries.
- Privacy policy and terms links.

## Chat Dissection Examples

The examples below are based on real code paths.

### Example 1: Explicit outreach request from caregiver

Input:

- Caregiver in Agent Desk: `please reach out to yashwanth and ask about access code`

Dissection:

1. Turn signals: no cancellation, no execute-pending.
2. Planner likely outputs `USE_TOOL + START_DELEGATION`.
3. Deterministic safety still validates explicit delegation directive and can force START_DELEGATION.
4. Router does not execute immediately; it sets pending `DELEGATION_CONTACT_CONFIRM` and asks confirmation.
5. Caregiver replies `yes`.
6. `executePending=true` triggers use of pending base command.
7. Target appointment resolved.
8. Delegation context compiled (objective/questions/type).
9. `startDelegationWindow()` writes active delegation and sends kickoff AI message to client/family chat.
10. Agent Desk responds with `mode=DELEGATION_STARTED` and window times.

### Example 2: Client info question with incomplete history

Input:

- Caregiver: `does he have ibuprofen at home?`

Dissection:

1. Planner may choose `CLIENT_INFO`.
2. Target appointment resolved.
3. Message history lookup runs; synthesized answer may indicate unknown/incomplete evidence.
4. Missing-info policy evaluates command + draft answer.
5. If policy -> `ACQUIRE_MISSING_INFO` and confidence >= 0.55, assistant asks delegation confirmation instead of giving dead-end.
6. Pending set to `DELEGATION_CONTACT_CONFIRM` for continuation.

### Example 3: Family reply during active delegation

Setup:

- Manual delegation active with primary questions:
- `Does he have Advil at home?`
- `If yes, where is it located in the home?`

Family message:

- `Yes, he has Advil in the cabinet by the microwave.`

Dissection:

1. AI interpreter receives incoming message event.
2. Readiness classifier may emit updates (if relevant).
3. Delegation gate passes (active delegation).
4. Delegation question assessment marks first question answered with high confidence.
5. Completion evaluator updates resolved indexes.
6. AI reply generated with next forced question if needed.
7. No incremental Agent Desk progress update is written (completion-only mode).
8. `resolvedQuestionIndexes` is persisted.

### Example 4: System precheck finishes with blocker

Setup:

- Precheck checklist completed; one check remains `FAIL`.

Dissection:

1. `checklistComplete(planner)` true, but failed checks exist.
2. Precheck summary generated:
- status line,
- confirmed/open blockers,
- caregiver action line.
3. For system-managed delegation entry, summary is written into delegation + summaryHistory.
4. `PRECHECK_ESCALATED` event inserted.
5. SYSTEM message written to `messages` to note caregiver follow-up required.
6. `PRECHECK_COMPLETED` event inserted with `outcome=ESCALATED`.

## Feature Flags and Runtime Switches

Agent Desk router (`appointment-management-service`):

- `OPENAI_API_KEY`
- `AGENT_ASSISTANT_MODEL` (default `gpt-4o-mini`)
- `ASSISTANT_AI_FIRST_INTENT_V1` (default true)
- `ASSISTANT_SINGLE_ROUTER_V1` (default true)
- `ASSISTANT_ENABLE_LEGACY_RECOVERY_V0` (default false)
- `ASSISTANT_AGENT_DESK_PERSISTENCE_V1` (default true)
- `ASSISTANT_DELEGATION_CONTEXT_COMPILER_V1` (default true)

AI interpreter:

- `OPENAI_API_KEY`
- `ASSISTANT_DELEGATION_COMPLETION_NOTIFY_V1`
- `READINESS_MIN_CONFIDENCE`
- `READINESS_REQUIRE_REASONING`
- `SQS_POLL_WAIT_SECONDS`
- `SQS_POLL_ERROR_BACKOFF_MS`
- `SQS_IDEMPOTENCY_TTL_MS`
- `SQS_IDEMPOTENCY_MAX_KEYS`
- `SQS_PERSISTENT_IDEMPOTENCY_TTL_HOURS`
- `SQS_PERSISTENT_IDEMPOTENCY_PRUNE_INTERVAL_MS`

Readiness engine precheck kickoff:

- `PRECHECK_KICKOFF_BATCH_SIZE`
- `PRECHECK_KICKOFF_MAX_CYCLES`

## Debugging Playbook

### 1) Determine which agent path executed

- Caregiver command path: inspect `/agents/:userId/command` response `data.mode` and `toolTrace`.
- Family/coordinator chat path: inspect `ai-interpreter` logs around `[AI] 📨 Processing:` and reply insertions.

### 2) Inspect latest Agent Desk state

Check `user_agents.persona_settings` for:

- `assistant.pending`
- `assistant.memory`
- `assistant.history`
- `delegations[appointmentId]`

### 3) Inspect persisted Agent Desk messages

Query `agent_desk_messages` by caregiver thread and sort by `created_at DESC`.

Look for:

- `source='AGENT_COMMAND'`
- `source='DELEGATION_COMPLETION'`
- dedupe behavior by `dedupe_key`.

### 4) Inspect appointment chat transcript

Query `messages` by `appointment_id` ordered ascending.

Look for:

- human turn -> AI_AGENT reply ordering,
- whether kickoff questions were sent,
- whether repeated question loops are present.

### 5) Inspect readiness event timeline

Query `readiness_events` by appointment and sort ascending.

Look for:

- `PRECHECK_STARTED`
- `PRECHECK_PLANNER`
- `PRECHECK_ESCALATED` (if any)
- `PRECHECK_COMPLETED`

### 6) Inspect queue dedupe ledger

Query `message_idempotency` by `consumer_name` and recent `processed_at`.

This confirms whether events were dropped as duplicates/non-retryable.

### 7) Use precheck reset/debug endpoints

Useful when precheck appears stuck or you need a clean replay:

- `GET /precheck/debug-candidates` to see currently kickoff-eligible appointments.
- `POST /appointments/:id/precheck/reset` to clear precheck markers/messages for one appointment and requeue readiness evaluation.
- `POST /precheck/reset-all` to clear global markers/messages and requeue eligible appointments.

Additional timeline event now used for interruption/debug:

- `PRECHECK_INTERRUPTED` when a manual delegation overrides an active system precheck.
- `PRECHECK_RESUMED` when precheck is resumed/restarted after manual delegation completion.

## Known Design Behaviors (Important for Debugging)

1. START_DELEGATION is confirmation-gated by design.
2. Missing-info policy can convert an answer path into delegation confirmation when facts are unknown.
3. Manual delegation completion does not auto-stop delegation; it posts completion updates only.
4. If caregiver sends a direct patient-chat message, active caregiver-managed delegation for that visit auto-ends.
5. New delegation asks during an active caregiver-managed window are appended into that same delegation (no new window created).
6. Precheck summary writes are blocked for caregiver-managed manual delegations to avoid overwrite.
7. Agent Desk persistence can degrade gracefully to legacy assistant history if `agent_desk_*` schema is missing.
8. Non-tool responses are sanitized to avoid false claims that actions were already executed.

## Test Coverage Pointers

Router/command-side tests:

- `services/appointment-management-service/src/delegation-intent-policy.test.ts`
- `services/appointment-management-service/src/turn-signal-policy.test.ts`
- `services/appointment-management-service/src/router-policy.test.ts`
- `services/appointment-management-service/src/router-contract-policy.test.ts`
- `services/appointment-management-service/src/assistant-policy.test.ts`
- `services/appointment-management-service/src/delegation-context-compiler.test.ts`
- `services/appointment-management-service/src/delegation-summary-policy.test.ts`

Interpreter-side tests:

- `services/ai-interpreter/src/delegation-policy.test.ts`
- `services/ai-interpreter/src/delegation-completion-policy.test.ts`
- `services/ai-interpreter/src/precheck-summary-policy.test.ts`

Eval seeds for command routing regression:

- `docs/evals/agent-routing-cases.json`

## Current Non-Production/Simulated AI Usage

`brief-service` includes comments for simulated OpenAI summarization but does not currently perform real model calls in code.
