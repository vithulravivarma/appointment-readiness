# Escalation System Implementation Spec

Last updated: March 11, 2026 (America/Los_Angeles)

## 1) Purpose
Define a concrete, build-ready escalation system that connects:

1. Delegated patient/family conversations.
2. Caregiver Agent Desk.
3. Scheduler operations workflow.

This spec assumes current behavior in this repository:

1. Delegation can run per appointment and auto-end when caregiver posts in patient chat.
2. Agent Desk commands route through `POST /agents/:userId/command`.
3. Coordinators can already access and post appointment chat messages (`sender_type='COORDINATOR'`).

## 2) Product Outcomes

1. If delegated AI cannot answer a client/family question safely, escalate to caregiver in Agent Desk with clear next actions.
2. Any caregiver-initiated escalation is high priority by default.
3. Scheduler receives and manages escalations through dedicated caregiver-scoped scheduler threads.
4. Critical precheck failures automatically notify scheduler.
5. Scheduler can:
   - inspect any appointment,
   - jump into appointment chat (same thread with caregiver + AI + client/family),
   - manually override readiness checks with audit trail.

## 3) Terminology

1. `Escalation`: A tracked issue requiring human intervention.
2. `Scheduler Thread`: A chat thread between scheduler(s) and one caregiver in Scheduler Desk.
3. `Appointment Chat`: Existing appointment-scoped chat in `messages`.
4. `Agent Desk`: Existing caregiver-assistant command chat in `agent_desk_messages`.

## 4) Escalation Categories

No separate `SAFETY_URGENT` category is introduced. Priority is determined by source and category:

1. `CLIENT_QUESTION_NEEDS_CAREGIVER`
   - Trigger: delegated agent lacks a grounded answer.
   - Priority: `HIGH` (because caregiver intervention is required).
2. `CAREGIVER_REQUESTS_SCHEDULER`
   - Trigger: caregiver asks for scheduler action/help from Agent Desk.
   - Priority: `HIGH` (all caregiver escalations are high priority).
3. `PRECHECK_CRITICAL_FAIL`
   - Trigger: precheck leaves any critical check as `FAIL`.
   - Priority: `HIGH`.

## 5) Data Model Changes

## 5.1 New table: `escalations`

```sql
CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id uuid NOT NULL REFERENCES users(id),
  appointment_id uuid REFERENCES appointments(id),
  delegation_id text,
  source text NOT NULL, -- AGENT_DESK | DELEGATED_CHAT | PRECHECK_AUTOMATION
  category text NOT NULL, -- CLIENT_QUESTION_NEEDS_CAREGIVER | CAREGIVER_REQUESTS_SCHEDULER | PRECHECK_CRITICAL_FAIL
  priority text NOT NULL DEFAULT 'HIGH', -- HIGH for all caregiver + precheck paths
  status text NOT NULL DEFAULT 'OPEN', -- OPEN | ACKNOWLEDGED | ACTION_REQUESTED | RESOLVED | HANDOFF_TO_CAREGIVER | AUTO_CLOSED
  summary text NOT NULL,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_by text NOT NULL, -- AI_AGENT | CAREGIVER | SYSTEM
  resolved_by text,
  resolution_type text, -- ANSWER_RELAYED | CAREGIVER_HANDOFF | SCHEDULER_RESOLVED | NO_ACTION
  opened_at timestamptz NOT NULL DEFAULT NOW(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX escalations_caregiver_status_idx ON escalations (caregiver_id, status, opened_at DESC);
CREATE INDEX escalations_appointment_status_idx ON escalations (appointment_id, status, opened_at DESC);
```

## 5.2 New table: `scheduler_threads`

```sql
CREATE TABLE scheduler_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id uuid NOT NULL UNIQUE REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
```

## 5.3 New table: `scheduler_thread_messages`

```sql
CREATE TABLE scheduler_thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES scheduler_threads(id) ON DELETE CASCADE,
  sender_type text NOT NULL, -- CAREGIVER | COORDINATOR | SYSTEM | AI_AGENT
  sender_id uuid REFERENCES users(id),
  content text NOT NULL,
  escalation_id uuid REFERENCES escalations(id),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX scheduler_thread_messages_thread_created_idx ON scheduler_thread_messages (thread_id, created_at DESC);
```

## 5.4 Readiness override audit additions

Extend readiness check manual update path to store:

1. `override_reason` (required when coordinator converts `FAIL` -> `PASS`).
2. `overridden_by` (`user_id`).
3. `override_source` (`SCHEDULER_MANUAL_OVERRIDE`).

Implementation can be done either in `readiness_checks` columns or via `readiness_events` details payload. Prefer events payload first for low migration risk.

## 6) Backend API and Contract Changes

## 6.1 Agent command route (`POST /agents/:userId/command`)

Add router tool action: `ESCALATE_SCHEDULER`.

Response payload when action triggered:

```json
{
  "mode": "SCHEDULER_ESCALATION_CREATED",
  "escalationId": "uuid",
  "threadId": "uuid",
  "priority": "HIGH",
  "message": "Scheduler has been notified. I shared the issue and context."
}
```

Deterministic guard:

1. When command contains explicit scheduler-help intent, route to `ESCALATE_SCHEDULER` even if other lower-priority tool intents are present.

## 6.2 New scheduler thread APIs

1. `GET /scheduler/threads`
   - Coordinator-only.
   - Returns caregiver-scoped threads with unread counts and open escalation count.
2. `GET /scheduler/threads/:caregiverId/messages`
   - Coordinator and that caregiver.
3. `POST /scheduler/threads/:caregiverId/messages`
   - Coordinator and that caregiver.
   - Persists message; optional `escalationId`.

## 6.3 New escalation APIs

1. `GET /escalations`
   - Filter by caregiver, appointment, status, category.
2. `POST /escalations` (internal service use; can be private route)
   - Creates escalation + writes scheduler-thread system message.
3. `PATCH /escalations/:id`
   - Status transitions + resolution metadata.

## 6.4 Existing endpoint hardening

`POST /appointments/:id/readiness/checks`:

1. Require authenticated user.
2. Allow only `CAREGIVER` or `COORDINATOR`.
3. Require appointment access check.
4. If role is `COORDINATOR` and status transition is `FAIL` -> `PASS`, require `overrideReason`.

## 7) AI and Router Logic

## 7.1 Delegated-chat unresolved-answer escalation

In `ai-interpreter` delegated reply flow:

1. Detect unresolved answer condition:
   - No grounded evidence in recent appointment context and delegation transcript, or
   - policy classifier flags “cannot answer safely.”
2. Do not produce fabricated answer.
3. Create escalation (`CLIENT_QUESTION_NEEDS_CAREGIVER`, `HIGH`).
4. Write one Agent Desk update to caregiver:
   - includes client question,
   - includes two actions:
     - “Reply here with what I should tell them.”
     - “Or message in patient chat to take over directly.”

Resolution paths:

1. Caregiver replies in Agent Desk with answer:
   - agent relays answer into appointment chat,
   - escalation `RESOLVED` + `resolution_type=ANSWER_RELAYED`.
2. Caregiver posts in patient chat:
   - existing auto-end manual delegation behavior runs,
   - escalation `HANDOFF_TO_CAREGIVER`.

## 7.2 Caregiver-to-scheduler escalation intent

In command planner contract:

1. Add intent label `SCHEDULER_INTERVENTION`.
2. Examples:
   - “I feel unsafe.”
   - “Client not responding, need scheduler help.”
   - “Can scheduler reassign or call backup?”

Deterministic override rule:

1. If router sees explicit scheduler-help phrases, force `ESCALATE_SCHEDULER`.

## 7.3 Precheck critical fail integration

When precheck completion yields any critical `FAIL`:

1. Create/open escalation `PRECHECK_CRITICAL_FAIL`.
2. Write scheduler thread message with:
   - appointment identity,
   - failed checks,
   - last evidence snippets,
   - recommendation to review/override/coordinate.

Dedupe guard:

1. Suppress duplicate open escalation for same appointment + category while one is `OPEN` or `ACKNOWLEDGED`.

## 8) Scheduler UX Model (Detailed)

## 8.1 Information Architecture

Scheduler Desk has three synchronized regions:

1. Left rail: caregiver threads (one thread per caregiver).
2. Main pane: scheduler thread messages and escalation cards.
3. Context pane: selected escalation + appointment actions.

## 8.2 Left rail (caregiver threads)

Each row shows:

1. Caregiver name.
2. Open escalation count.
3. Highest priority badge (`HIGH`).
4. Last update timestamp.
5. Unread badge.

Default sorting:

1. Threads with open escalations first.
2. Then most recent activity.

## 8.3 Main pane (thread + escalation timeline)

Message types:

1. Freeform chat messages (`CAREGIVER` / `COORDINATOR`).
2. System escalation cards (`SYSTEM`):
   - category,
   - summary,
   - appointment,
   - status chips,
   - quick actions (`Acknowledge`, `Resolve`, `Jump to Appointment Chat`).

## 8.4 Context pane (action surface)

For selected escalation:

1. Appointment details and timeline link.
2. Current readiness critical checks with statuses.
3. Delegation status for appointment.
4. Override controls for readiness checks with required reason input.
5. Buttons:
   - `Jump to Appointment Chat`
   - `Mark Acknowledged`
   - `Mark Resolved`

## 8.5 "Jump to Appointment Chat" behavior (in-depth)

Purpose: move scheduler from coordination view into the live appointment conversation quickly, without losing escalation context.

Detailed behavior:

1. Action source:
   - available on escalation card and context pane.
2. Click action:
   - front-end routes to appointment chat screen with query/state:
     - `appointmentId`,
     - `fromEscalationId`,
     - `returnThreadId`.
3. Chat composer identity:
   - all outgoing messages sent via existing `POST /messages` with authenticated role `COORDINATOR`.
   - stored in `messages.sender_type='COORDINATOR'`.
4. Participant visibility:
   - scheduler sees full appointment chat (same thread caregiver/AI/family/client already use).
5. Back-navigation:
   - a visible “Back to Scheduler Thread” action returns scheduler to prior thread and focuses linked escalation card.
6. Audit and observability:
   - emit event `SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT` with `threadId`, `escalationId`, `appointmentId`.
7. Optional convenience insertion:
   - scheduler can insert a system note in scheduler thread: “Joined appointment chat for live intervention.”

This is navigation + identity continuity, not a separate messaging channel.

## 9) Priority and SLA Rules

1. All caregiver-originated escalations are `HIGH`.
2. Precheck critical fail escalations are `HIGH`.
3. UI target SLA indicators (initial):
   - `ACKNOWLEDGED` within 5 minutes.
   - `RESOLVED` within operational policy window.

## 10) State Transitions

Allowed transitions:

1. `OPEN` -> `ACKNOWLEDGED`
2. `OPEN` -> `RESOLVED`
3. `ACKNOWLEDGED` -> `ACTION_REQUESTED`
4. `ACTION_REQUESTED` -> `RESOLVED`
5. `OPEN|ACKNOWLEDGED|ACTION_REQUESTED` -> `HANDOFF_TO_CAREGIVER`
6. `OPEN|ACKNOWLEDGED` -> `AUTO_CLOSED` (dedupe/expired/no action needed)

## 11) Eventing and Observability

Emit readiness/agent events:

1. `ESCALATION_OPENED`
2. `ESCALATION_ACKNOWLEDGED`
3. `ESCALATION_RESOLVED`
4. `ESCALATION_HANDOFF_TO_CAREGIVER`
5. `PRECHECK_CRITICAL_ESCALATION_OPENED`
6. `READINESS_OVERRIDE_APPLIED`
7. `SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT`

Dashboard metrics:

1. Open escalations by category.
2. Time-to-ack and time-to-resolve.
3. Handoff rate (caregiver takeover).
4. Duplicate suppression count.

## 12) Security and Access Control

1. Scheduler routes require `COORDINATOR`.
2. Caregiver can only access their own scheduler thread.
3. Escalation queries are filtered by role access:
   - caregiver: own only,
   - coordinator: all.
4. Readiness override requires authenticated coordinator + audit reason.

## 13) Implementation Sequence (Patch Plan)

## Patch 1: Core schema + services

1. Add `escalations`, `scheduler_threads`, `scheduler_thread_messages`.
2. Add escalation repository helpers in `appointment-management-service`.
3. Add basic APIs (`GET/POST/PATCH` for escalations + scheduler thread read/write).

## Patch 2: Command and delegated escalation routing

1. Add router action `ESCALATE_SCHEDULER`.
2. Add scheduler-intent deterministic override.
3. Add delegated unresolved-answer escalation creation + caregiver desk notification.

## Patch 3: Precheck critical fail + readiness override hardening

1. Wire precheck critical fail -> escalation + scheduler thread message.
2. Harden `POST /appointments/:id/readiness/checks` auth + override reason requirements.
3. Add dedupe/cooldown logic for repeated escalation triggers.

## Patch 4: Scheduler Desk UX

1. Build scheduler threads list + message pane + context pane.
2. Add escalation action controls.
3. Implement `Jump to Appointment Chat` deep-link + return navigation.

## Patch 5: Stabilization + QA hardening

1. Add escalation cards with inline quick actions in Scheduler Desk timeline.
2. Persist `SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT` observability event when scheduler jumps.
3. Add safe local coordinator fallback auth for development, with production guard.
4. Harden deep-link return parameters (`returnCaregiverId`, `returnThreadId`, `fromEscalationId`).
5. Run manual QA pass for Patch 4/5 behavior matrix before release.

## 14) Testing Plan

## 14.1 Unit tests

1. Escalation dedupe rules.
2. State transition validation.
3. Router override for scheduler-help intents.

## 14.2 Integration tests

1. Delegated unresolved question -> escalation opened -> caregiver answer relay -> resolved.
2. Caregiver message in patient chat -> delegation auto-end + escalation handoff.
3. Precheck critical fail -> scheduler thread receives one escalation card.
4. Coordinator override `FAIL` -> `PASS` requires reason and is audited.

## 14.3 UI/e2e tests

1. Scheduler thread list ordering by open escalations then recency.
2. Jump to appointment chat sends as coordinator and returns to original thread.
3. Escalation cards reflect state updates in near real-time.

## 15) Open Decisions (to resolve before coding)

1. Should scheduler thread messages notify caregiver immediately (push/in-app badge) or only on open?
2. Should unresolved delegated-question escalations auto-close after caregiver inactivity timeout?
3. Should coordinator “resolved” require a structured resolution note?

## 16) Phase 5 Execution Notes (Implemented)

1. Scheduler Desk now includes explicit escalation cards with:
   - `Acknowledge`,
   - `Resolve`,
   - `Jump` actions.
2. Scheduler jump action now:
   - writes a scheduler thread note,
   - writes `SCHEDULER_JUMPED_TO_APPOINTMENT_CHAT` into `readiness_events`,
   - carries return context so chat can navigate back to scheduler thread.
3. Dev coordinator fallback account:
   - can be toggled with `ALLOW_LOCAL_COORDINATOR_FALLBACK`,
   - defaults enabled only when `NODE_ENV != production`,
   - uses UUID-safe coordinator id by default.
4. Manual QA checklist completed in code pass (no runtime execution in this environment):
   - coordinator login route points to Scheduler Desk,
   - scheduler thread loading + escalation list binding reviewed,
   - escalation state actions invoke `PATCH /escalations/:id`,
   - readiness override path enforces reason on `FAIL -> PASS`,
   - jump/return navigation params wired end-to-end.
