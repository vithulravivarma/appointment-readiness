# Escalation Phase 5 QA Checklist

Last updated: March 11, 2026 (America/Los_Angeles)

## Preconditions

1. Services are up (`appointment-management-service`, `ai-interpreter`, `readiness-engine`).
2. DB migrations include escalation/scheduler tables.
3. Mobile app can sign in with coordinator role.

## Auth and Entry

1. Open login screen.
2. Confirm coordinator role appears in role filter.
3. Sign in as coordinator and verify destination is `Scheduler Desk`.
4. If no coordinator account is provisioned, use local fallback login (`scheduler-local` / `demo123`) in development.

Expected:
- Scheduler Desk loads.
- No 401/403 on `/scheduler/threads`.

## Scheduler Thread List

1. Verify threads are ordered with open-escalation threads first.
2. Select multiple caregiver threads.
3. Confirm timeline and escalation context switch to selected caregiver.

Expected:
- Thread rail updates selected state.
- Timeline messages and escalations match selected caregiver.

## Escalation Actions

1. In timeline escalation cards, click `Acknowledge`.
2. Verify escalation status updates to `ACKNOWLEDGED`.
3. Click `Resolve`.
4. Verify status updates to `RESOLVED`.

Expected:
- `PATCH /escalations/:id` succeeds.
- Scheduler thread receives status update system message.

## Jump to Appointment Chat

1. On escalation card (or context pane), click `Jump`.
2. Verify scheduler is routed to appointment chat as `COORDINATOR`.
3. Confirm chat composer sends messages with coordinator identity.
4. Click `Back to Scheduler Thread`.

Expected:
- Return navigates to same scheduler thread.
- Prior escalation remains focused.
- `SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT` event is recorded.

## Readiness Override

1. In selected escalation context, set a critical check to `FAIL`.
2. Set same check from `FAIL` to `PASS` without reason.

Expected:
- API rejects with override reason requirement.

3. Enter override reason.
4. Set `FAIL` -> `PASS` again.

Expected:
- API accepts.
- Override audit event written.

## Delegation Context

1. Pick escalation with appointment tied to active delegation.
2. Confirm active delegation summary appears in context pane.

Expected:
- Shows active status/window/objective when present.
- Shows clear empty-state if none.

## Regression Checks

1. Caregiver chat and Agent Desk still load normally.
2. Appointment list navigation still works for coordinator/caregiver.
3. No crashes from deep-link params (`returnCaregiverId`, `returnThreadId`, `fromEscalationId`).

## Environment Toggles

1. `ALLOW_LOCAL_COORDINATOR_FALLBACK=true` enables local fallback account.
2. In production (`NODE_ENV=production`) fallback is disabled by default unless explicitly enabled.

