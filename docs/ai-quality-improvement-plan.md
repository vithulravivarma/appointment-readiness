# AI Quality Improvement Plan (Caregiver Agent)

## Outcomes We Want
- Higher answer quality with fewer follow-up loops.
- More reliable complex delegation behavior (manual and precheck can coexist without interference).
- Lower per-turn latency and cost by reducing unnecessary model hops.
- Production readiness for AWS deployment with strong delivery guarantees.

## Current Gaps (Observed in Code)
- Too many model calls can happen in one caregiver turn (classification + planning + recovery + sanitization + optional resolvers).
- Manual delegation can be overridden by precheck automation behavior in some paths.
- Date handling is inconsistent for schedule/maps flows (today-centric behavior even when caregiver asks for other dates).
- Client-history lookup accepts `appointmentLimit` but does not consistently enforce a scoped appointment set.
- Queue consumers lack DLQ/retry/idempotency hardening expected for production.

## Success Metrics
- `follow_up_loop_rate`: percent of turns with repeated clarification prompts.
- `turns_to_completion`: median turns to complete route/client-info/delegation tasks.
- `delegation_completion_quality`: percent of delegations with all requested caregiver questions resolved or explicitly marked unresolved.
- `latency_p95_ms` for `/agents/:userId/command`.
- `tool_success_rate` by tool and `degraded_answer_rate`.

## Prioritized Backlog

## P0: Correctness + Delegation Quality (Immediate)
1. Protect manual delegations from precheck overwrite.
   - Acceptance:
   - Manual delegation state is not replaced by precheck completion summary writes.
   - Precheck completion still emits readiness events and escalation signals.

2. Prioritize manual delegation prompts during active manual delegation.
   - Acceptance:
   - When a caregiver starts manual delegation, next questions come from caregiver-defined delegation questions first.
   - Precheck checklist questions do not hijack manual delegation unless no manual question remains.

3. Enforce appointment-scope lookup limits.
   - Acceptance:
   - `appointmentLimit` controls how many appointment IDs are searched for client-history retrieval.
   - Response reports scanned appointments/messages from the actual scoped set.

4. Date-aware schedule and maps behavior.
   - Acceptance:
   - `today/tomorrow/yesterday/explicit date` hints are honored by schedule and maps tools.
   - Responses reference the requested business date, not always "today".

5. Add regression tests for P0 paths.
   - Acceptance:
   - Tests cover manual delegation vs precheck interaction.
   - Tests cover date-scoped schedule/maps and appointment-limited client lookup.

## P1: Orchestration Simplification + Reliability
1. Collapse multi-hop planner chain into one primary router contract per turn.
   - Return structured fields: `action`, `tool`, `required_slots`, `response_style`.
2. Add deterministic guardrail layer before/after model.
   - Slot filling and context resolution deterministic first; model only where ambiguity remains.
3. Introduce optimistic concurrency for assistant/delegation state.
   - Add `version` (or `updated_at` compare-and-swap) to `user_agents` writes.
4. Queue reliability hardening.
   - DLQ + redrive strategy, explicit retry classes, idempotency key checks.

## P2: Eval Harness + AWS Productionization
1. Build transcript replay eval harness.
   - Golden datasets from real caregiver turns and delegation transcripts.
   - CI gate on quality metrics deltas.
2. Observability.
   - Structured traces with request/turn IDs and per-tool latency/error dashboards.
3. AWS architecture hardening.
   - ECS/Fargate workers, RDS tuning/indexes, SQS DLQs/FIFO where ordering matters, secrets via AWS Secrets Manager, autoscaling policies.
4. Channel expansion readiness.
   - Canonical conversation/thread schema and channel adapters aligned with conversation framework.

## Recommended Execution Order
1. Ship all P0 correctness fixes and tests.
2. Add eval metrics and dashboards for before/after comparison.
3. Start P1 router simplification with a feature flag.
4. Move to AWS hardening once P0/P1 are stable in staging.

## Rollout Strategy
- Feature flags per risk area:
  - `ASSISTANT_DATE_SCOPING_V1`
  - `ASSISTANT_APPOINTMENT_LIMIT_ENFORCED_V1`
  - `DELEGATION_MANUAL_PRIORITY_V1`
- Shadow/observe first, then progressive rollout by caregiver cohort.

## Near-Term Deliverables (This Cycle)
- P0 code fixes for delegation/manual priority and lookup/date correctness.
- This plan document and acceptance criteria for next ticket breakdown.

## Implementation Status (Current)
- P0 items 1-4 are implemented in services.
- P0 regression tests are added for delegation/manual priority and date/lookup policy modules.
- P1 item 1 (router simplification) is partially implemented:
  - single-router mode is feature-flagged (`ASSISTANT_SINGLE_ROUTER_V1`).
  - planner-repair and legacy recovery hops are disabled in single-router mode.
  - planner decision contract now includes normalized `required_slots` and `response_style`.
- P1 item 2 (deterministic guardrails) is implemented in narrow mode:
  - deterministic turn-signal policy handles only high-confidence control intents (`cancel`, `execute pending`).
  - all other turn-signal classification falls through to LLM.
- P1 item 3 (optimistic concurrency on assistant state) is implemented with settings version compare-and-swap.
- P1 item 4 (queue reliability hardening) is mostly implemented:
  - SQS consumers now classify handler failures into retryable vs non-retryable.
  - Non-retryable malformed payloads are acknowledged to prevent poison-loop retries.
  - Retryable failures are left in queue for visibility-timeout retry / DLQ redrive policy.
  - Consumers now use receive-count system attributes and a local idempotency cache for duplicate suppression.
  - Primary DB-backed consumers (`ai-interpreter`, `readiness-engine`) now persist idempotency keys in `message_idempotency`.
  - Local queue bootstrap now provisions per-queue DLQs and redrive defaults (`scripts/setup-local.sh`, reused by `start-all.sh`).
- Summary quality slice is implemented:
  - Precheck completion now uses concise caregiver-readable summary text (status + blockers + action).
  - Manual delegation stop now uses a structured caregiver summary formatter (outcome, key updates, follow-up items, traffic).

## Next Steps (Recommended)
1. Queue reliability hardening completion (AWS deploy path)
   - Mirror local DLQ/redrive defaults in AWS IaC modules (Terraform/CDK/CloudFormation).
   - Add CloudWatch alarms for DLQ depth and age.
2. P2 eval harness bootstrap
   - Create transcript replay runner and baseline metrics output (`follow_up_loop_rate`, `turns_to_completion`, `tool_success_rate`).
