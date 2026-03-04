# Agent Routing Architecture (Appointment Management Service)

This document describes how `/agents/:userId/command` decides whether to:
- answer directly,
- ask a follow-up,
- execute a tool (`SCHEDULE_DAY`, `MAPS_ROUTE`, `CLIENT_INFO`, `START_DELEGATION`).

## Core Principles

1. AI-first intent routing
- The planner LLM is the primary decision-maker for intent/action.
- Flag: `ASSISTANT_AI_FIRST_INTENT_V1=true`.

2. Deterministic safety controls
- Deterministic logic is kept for narrow control/safety paths:
  - cancel/ack/execute-pending turn signals,
  - deterministic fallback when planner fails,
  - forced delegation override for explicit outreach directives.

3. No fake execution claims
- If no backend tool actually ran, responses are sanitized to avoid claiming actions were performed.

## High-Level Flow

1. Ingest caregiver turn and append to assistant history.
2. Analyze turn signals (greeting, acknowledgement, cancellation, continue pending).
3. Load caregiver appointments and resolve context.
4. Planner decision:
   - AI-first: `planAssistantDecisionWithLLM(...)`.
   - If unavailable/invalid: deterministic fallback.
5. Apply router contract defaults (`required_slots`, `response_style`).
6. Safety override:
   - If command is explicit delegation directive (including find-out requests about client/family), force `START_DELEGATION`.
7. Missing-info policy gate (AI + deterministic fallback):
   - Evaluates whether response is complete from known info vs requires acquisition of missing client/family facts.
   - If acquisition is needed, route to delegation confirmation instead of ending with a dead-end answer.
8. Delegation confirmation gate:
   - Before executing `START_DELEGATION`, ask caregiver to confirm contact.
   - Only execute on a clear affirmative follow-up (`yes`, `go ahead`, etc.).
9. Delegation context compiler:
   - Build delegation objective/questions from semantic context and persistent Agent Desk evidence (not fixed N-message windows).
   - Classify delegation type (`FACT_CHECK`, `LOGISTICS`, `OPEN_ENDED`) and enforce question budget by type.
   - Mark questions as `PRIMARY` vs `OPTIONAL` (completion requires `PRIMARY`).
10. Persistent Agent Desk history:
   - Caregiver and assistant turns are written to `agent_desk_messages` and available via `GET /agents/:userId/chat/history`.
11. Delegation completion updates:
   - When all askable delegation questions are resolved, write a concise caregiver update to Agent Desk chat (idempotent, no auto-stop).
   - Progress updates are also written when new `PRIMARY` facts are resolved.
   - For `FACT_CHECK`, kickoff can batch primary asks in a single opening message to minimize client overhead.
12. Execute tool or return non-tool response.
13. Sanitize non-tool response to remove execution claims.

## Delegation Intent Detection

File: `services/appointment-management-service/src/delegation-intent-policy.ts`

Current delegation intent triggers include:
- Explicit delegation terms: `delegate`, `delegation`.
- Outreach directives: `reach out`, `contact`, `message`, `text`, `check with`, `follow up with`.
- Ask directives: `ask client/family/...`.
- Named person patterns: `ask yashwanth ...`, `reach out to yashwanth ...`.
- Find-out directives tied to a person/context:
  - e.g. `if you don't know, can you find out for me`.

## Tool Routing Notes

- `CLIENT_INFO` is for known history lookup.
- `START_DELEGATION` is for collecting unknown info from client/family participants.
- If caregiver explicitly asks to find out from the person/family, routing should choose `START_DELEGATION`, not `RESPOND`.
- Missing-info policy checks both `RESPOND` and `CLIENT_INFO` outputs and can escalate to delegation confirmation when facts remain unknown.
- For safety, delegation contact is confirmation-gated before execution.

## Important Files

- Main command endpoint + orchestration:
  - `services/appointment-management-service/src/index.ts`
- Router policy flags:
  - `services/appointment-management-service/src/router-policy.ts`
- Delegation intent policy:
  - `services/appointment-management-service/src/delegation-intent-policy.ts`
- Router contract normalization:
  - `services/appointment-management-service/src/router-contract-policy.ts`

## Runtime Flags

- `ASSISTANT_AI_FIRST_INTENT_V1` (default `true`)
- `ASSISTANT_SINGLE_ROUTER_V1`
- `ASSISTANT_ENABLE_LEGACY_RECOVERY_V0`
- `AGENT_ASSISTANT_MODEL`

## Eval Seeds

- `docs/evals/agent-routing-cases.json`
- Use this as a baseline replay set for routing regressions (delegation vs known-info answer vs tool selection).

## Known Tradeoff

AI-first intent is more flexible, but deterministic safety overrides remain necessary for:
- guaranteed handling of explicit caregiver directives,
- predictable behavior during planner failures,
- preventing "no-op" conversational loops.
