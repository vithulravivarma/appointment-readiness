# Conversation Framework v1 (Caregiver Assistant + Multi-Channel Ready)

## 1. Goals
1. Keep all appointment data ingested as source of truth.
2. Reduce caregiver/client confusion from far-future appointments in chat UX.
3. Support future channels (Twilio SMS, WhatsApp, email, app chat) without rewriting core logic.
4. Ensure the assistant can answer clearly with explicit context (which client, which appointment, which channel).

## 2. Core Product Principles
1. Separate `data retention` from `default visibility`.
2. Default user experience should be operationally focused (near-term care).
3. Context must be explicit and inspectable.
4. Channel should be transport, not business logic.
5. Appointment context should be attached to conversation events, not used as the only conversation container.

## 3. Canonical Domain Model
1. `ConversationThread`
Type: logical conversation container.
Examples: caregiver-client relationship thread, appointment-scoped thread, escalation thread.

2. `ConversationParticipant`
Type: person/account in thread.
Examples: caregiver, family member, coordinator, AI assistant.

3. `ConversationMessage`
Type: canonical message record.
Stores: sender, body, timestamps, thread_id, channel_id, appointment_id nullable, metadata.

4. `ChannelEndpoint`
Type: transport endpoint binding.
Examples: app user id, SMS number, WhatsApp number, email address.

5. `ChannelMessageLink`
Type: idempotency and provider mapping.
Stores: provider (`twilio_sms`, `twilio_whatsapp`, `email`, `in_app`), provider_message_id, delivery states.

6. `ContextBinding`
Type: explicit context attachment.
Stores: `appointment_id nullable`, `client_id`, `caregiver_id`, `confidence`, `resolver_reason`.

## 4. Threading Strategy (Clarity First)
1. Primary model: one persistent caregiver<->client relationship thread.
2. Appointment context is a message-level/tag-level binding, not separate chat windows by default.
3. Optional appointment-focused sub-view: filter thread by appointment/date.
4. If needed later: add appointment subthreads for compliance/reporting, but keep user-facing primary thread consistent.

## 5. Visibility Windows (Fix Current Confusion)
1. Keep all future appointments in DB and APIs.
2. UI default views:
`Operational window`: from `today - 1 day` to `today + 7 days`.
3. Secondary views:
`Upcoming later`: `today + 8 days` onward (collapsed by default).
4. Chat header always shows active context:
`Context: Next visit <date/time> (switch)`.
5. Assistant answers should include context line when ambiguity exists:
`Using context: Client X, appointment on 2026-02-28`.

## 6. Context Resolution Rules
1. Explicit user selection wins (selected appointment/thread filter).
2. Explicit user mention wins next (name/date in message).
3. Pending follow-up context wins if still fresh (for short follow-up turns).
4. Otherwise choose next upcoming appointment for that caregiver-client pair.
5. If confidence is low, ask one follow-up question before tool execution.
6. Always persist resolver decision in `ContextBinding` for traceability.

## 7. Multi-Channel Integration Framework
1. Inbound adapters normalize provider payloads to canonical envelope.
2. Outbound dispatcher maps canonical message to selected channel with delivery tracking.
3. Channel adapters are plug-ins implementing the same contract:
`parseInbound`, `sendOutbound`, `statusWebhook`, `validateSignature`.
4. Provider-specific identifiers are stored only in `ChannelMessageLink`.
5. Business logic consumes only canonical messages and context bindings.

## 8. Canonical Inbound Message Envelope
1. `external_provider`: `twilio_sms|twilio_whatsapp|email|in_app`
2. `external_message_id`
3. `external_conversation_id` if present
4. `received_at`
5. `from_endpoint`, `to_endpoint`
6. `normalized_sender_person_id` nullable until resolved
7. `content_text`
8. `attachments[]`
9. `thread_hint` nullable
10. `appointment_hint` nullable
11. `idempotency_key`

## 9. Identity Resolution Framework
1. Resolve endpoint to person via verified endpoint mapping table.
2. If multiple matches exist, use thread membership + recent activity.
3. If unresolved, queue for coordinator review and hold tool actions.
4. Keep raw payload for audit.

## 10. Assistant Behavior Framework
1. Assistant decides `respond`, `ask_follow_up`, or `use_tool`.
2. Tool calls require resolved context above confidence threshold.
3. If no tool is suitable, provide normal freeform assistant response.
4. Assistant must never imply live external data access unless a tool was executed.
5. Every assistant answer carries hidden trace metadata:
`decision`, `tool_used`, `context_used`, `sources`.

## 11. API Contract Direction
1. `GET /conversations`
Returns logical threads with operational/upcoming grouping.

2. `GET /conversations/:id/messages`
Returns canonical messages, optional filters:
`appointmentId`, `dateFrom`, `dateTo`, `channel`.

3. `POST /conversations/:id/messages`
Creates canonical message and dispatches by preferred channel.

4. `POST /webhooks/:provider/inbound`
Adapter endpoint for Twilio/email/etc, normalizes then writes canonical message.

5. `GET /conversations/:id/context`
Returns current active context, confidence, and alternatives.

## 12. UI v1 Spec
1. Left pane:
`Current & soon` section and collapsed `Later appointments` section.
2. Center pane:
single continuous thread timeline.
3. Context bar above composer:
active client, active appointment date/time, channel badge, `switch context` action.
4. Toggle:
`Show all future appointments`.
5. Search:
global thread search across all dates/channels with context chips.

## 13. Migration Plan
1. Phase 1 (now):
keep existing tables, introduce operational window and explicit context bar in UI.

2. Phase 2:
introduce canonical `conversation_threads` and `conversation_messages` abstractions mapped from current `messages`.

3. Phase 3:
add channel adapters (Twilio SMS first, then WhatsApp, then email).

4. Phase 4:
switch assistant tools to canonical conversation store only.

## 14. Non-Negotiable Guardrails
1. Idempotency on inbound webhooks by provider message id.
2. Signed webhook verification per provider.
3. Full audit trail of raw payload and normalized record.
4. PII-safe logging and redaction.
5. Deterministic context resolver with explainable reasons.

## 15. Immediate Decisions to Lock
1. Single primary relationship thread per caregiver-client pair.
2. Appointment context attached to messages, not one separate chat window per appointment.
3. Operational visibility window default: `today -1` to `today +7`.
4. Assistant must include context disclosure when ambiguity exists.
5. Channel adapters must normalize into one canonical schema before any business logic.

## 16. Open Questions
1. Do we need legal/compliance requirement for separate immutable appointment transcripts?
2. Can one client choose multiple simultaneous channels, and if so what is channel priority?
3. Should coordinator messages be in the same thread or a separate internal-only layer?
4. What is acceptable delay for webhook-to-message availability SLA?

