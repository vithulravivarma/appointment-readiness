# Agent Tools Contract (Draft v1)

## Purpose
Define a stable contract for caregiver-facing agent capabilities so we can:
- keep schedule/client answers grounded in system-of-record data,
- add external context tools (maps, weather) safely,
- keep `Agent Desk` responses consistent across backend and mobile UI.

This spec targets the existing command endpoint:
- `POST /agents/:userId/command` in `appointment-management-service`.

## Scope And Non-Goals
In scope:
- tool contracts (input, output, error shape),
- orchestration order,
- source attribution and fallback behavior.

Out of scope:
- LLM prompt text,
- provider-specific SDK code,
- UI copy polishing.

## Time And Date Rules
- Canonical business timezone: `America/Los_Angeles`.
- Relative dates (`today`, `tomorrow`) must be resolved to explicit `YYYY-MM-DD` before tool calls.
- Tool outputs must include machine-readable timestamps in ISO 8601.

## Command API Envelope
Current command request supports:
```json
{
  "command": "plan my route and weather for tomorrow",
  "appointmentId": "optional-uuid",
  "durationMinutes": 30,
  "forceStart": false,
  "homeAddress": "optional override",
  "searchLimits": {
    "appointmentLimit": 6,
    "messageLimit": 180,
    "snippetLimit": 4
  }
}
```

Standardized response envelope (extends current shape, backward compatible):
```json
{
  "success": true,
  "data": {
    "mode": "ANSWERED",
    "intent": "MAPS_ROUTE",
    "response": "human-readable answer",
    "resolvedAppointment": {
      "appointmentId": "uuid",
      "clientId": "uuid",
      "clientName": "Client Name",
      "appointmentStartTime": "2026-02-26T15:00:00.000Z"
    },
    "toolTrace": [
      {
        "tool": "schedule.get_day",
        "ok": true,
        "source": "postgres",
        "latencyMs": 34,
        "fetchedAt": "2026-02-25T08:00:00.000Z"
      }
    ]
  }
}
```

`toolTrace` is optional for compatibility and should be progressively added.

## Tool Catalog

### Implemented Tools (Current)

### 1) `schedule.get_day`
Owner: `appointment-management-service`  
Source: PostgreSQL (`appointments`, `clients`)

Input:
```json
{
  "userId": "caregiver-uuid",
  "date": "2026-02-26",
  "timezone": "America/Los_Angeles"
}
```

Output:
```json
{
  "appointments": [
    {
      "appointmentId": "uuid",
      "clientId": "uuid",
      "clientName": "Client Name",
      "startTime": "ISO",
      "endTime": "ISO",
      "serviceType": "string",
      "appointmentStatus": "SCHEDULED|IN_PROGRESS|COMPLETED|CANCELLED",
      "locationAddress": "string"
    }
  ]
}
```

### 2) `appointment.resolve_target`
Owner: `appointment-management-service`  
Source: in-memory selection logic over `schedule.get_day` or caregiver appointment list.

Input:
```json
{
  "userId": "caregiver-uuid",
  "command": "what did family say about meds for anisha",
  "appointmentId": "optional-uuid"
}
```

Output:
```json
{
  "resolvedAppointment": {
    "appointmentId": "uuid",
    "clientId": "uuid",
    "clientName": "Client Name",
    "appointmentStartTime": "ISO"
  },
  "confidence": 0.0
}
```

### 3) `chat.lookup_client_info`
Owner: `appointment-management-service`  
Source: PostgreSQL (`messages`, scoped by caregiver/client appointments)

Input:
```json
{
  "userId": "caregiver-uuid",
  "clientId": "client-uuid",
  "clientName": "Client Name",
  "question": "what meds update did they share?",
  "searchLimits": {
    "appointmentLimit": 6,
    "messageLimit": 180,
    "snippetLimit": 4
  }
}
```

Output:
```json
{
  "response": "summary text",
  "scannedAppointments": 6,
  "scannedMessages": 132,
  "evidence": [
    {
      "appointmentId": "uuid",
      "appointmentStartTime": "ISO",
      "createdAt": "ISO",
      "senderType": "FAMILY|CAREGIVER|AI_AGENT|SYSTEM|COORDINATOR",
      "content": "raw snippet"
    }
  ]
}
```

### 4) `maps.estimate_leg`
Owner: `appointment-management-service`  
Provider: Google Maps Distance Matrix

Input:
```json
{
  "originAddress": "string",
  "destinationAddress": "string",
  "departureTime": "ISO"
}
```

Output:
```json
{
  "origin": "string",
  "destination": "string",
  "departureTime": "ISO",
  "durationMinutes": 42,
  "distanceMeters": 21100,
  "provider": "GOOGLE_MAPS_DISTANCE_MATRIX"
}
```

### 5) `maps.plan_day`
Owner: `appointment-management-service`  
Depends on: `schedule.get_day`, `maps.estimate_leg`, caregiver `home_address` or request override.

Input:
```json
{
  "userId": "caregiver-uuid",
  "date": "2026-02-26",
  "appointmentId": "optional-uuid",
  "homeAddressOverride": "optional string",
  "includeHomeStart": true,
  "includeHomeEnd": false
}
```

Output:
```json
{
  "legs": [
    {
      "origin": "string",
      "destination": "string",
      "departureTime": "ISO",
      "durationMinutes": 18,
      "distanceMeters": 9500
    }
  ],
  "totalDurationMinutes": 54
}
```

### 6) `delegation.start_window`
Owner: `appointment-management-service`  
Source: PostgreSQL (`readiness_checks`, `messages`, `user_agents`)

Input:
```json
{
  "userId": "caregiver-uuid",
  "appointmentId": "uuid",
  "objective": "string",
  "questions": ["string"],
  "durationMinutes": 30,
  "forceStart": false
}
```

Output:
```json
{
  "ok": true,
  "delegation": {
    "appointmentId": "uuid",
    "active": true,
    "startedAt": "ISO",
    "endsAt": "ISO",
    "objective": "string",
    "questions": ["string"]
  }
}
```

409 behavior:
```json
{
  "ok": false,
  "error": "Critical readiness checks are failed...",
  "failedChecks": ["ACCESS_CONFIRMED"]
}
```

## Planned Tools (Next)

### 7) `geo.geocode_address` (planned)
Purpose: normalize appointment/home addresses for weather lookup.

Input:
```json
{
  "address": "string"
}
```

Output:
```json
{
  "lat": 37.0001,
  "lng": -121.0001,
  "normalizedAddress": "string",
  "provider": "GOOGLE_GEOCODING|CACHED"
}
```

Caching:
- key: normalized address,
- TTL: 30 days.

### 8) `weather.get_hourly` (planned)
Purpose: get forecast for appointment windows and travel windows.

Input:
```json
{
  "lat": 37.0,
  "lng": -121.0,
  "from": "ISO",
  "to": "ISO",
  "timezone": "America/Los_Angeles"
}
```

Output:
```json
{
  "hours": [
    {
      "time": "ISO",
      "tempF": 63,
      "precipProb": 0.45,
      "precipIn": 0.06,
      "windMph": 16,
      "conditionCode": "rain"
    }
  ],
  "provider": "OPEN_METEO|OPENWEATHER"
}
```

Caching:
- key: `lat,lng,time-bucket`,
- TTL: 15 minutes.

### 9) `weather.assess_visit_risk` (planned)
Purpose: convert raw weather into operational guidance.

Input:
```json
{
  "appointments": [
    {
      "appointmentId": "uuid",
      "startTime": "ISO",
      "endTime": "ISO",
      "lat": 37.0,
      "lng": -121.0
    }
  ],
  "routeLegs": [
    {
      "departureTime": "ISO",
      "durationMinutes": 25
    }
  ]
}
```

Output:
```json
{
  "visitRisks": [
    {
      "appointmentId": "uuid",
      "weatherRisk": "LOW|MEDIUM|HIGH",
      "reasons": ["Heavy rain during arrival window"],
      "recommendedBufferMinutes": 10
    }
  ],
  "routeRiskSummary": "Expect rain during mid-day travel."
}
```

### 10) `context.day_brief` (planned composer tool)
Purpose: single-call response for questions like "How does tomorrow look?"

Input:
```json
{
  "userId": "caregiver-uuid",
  "date": "2026-02-26",
  "includeRoute": true,
  "includeWeather": true,
  "includeReadiness": true
}
```

Output:
```json
{
  "summaryText": "human-readable combined brief",
  "schedule": {},
  "route": {},
  "weather": {},
  "readiness": {},
  "recommendations": ["Leave 15m earlier for second visit"]
}
```

## Orchestration Rules
1. Resolve date scope first (`today`, `tomorrow`, explicit date).
2. For schedule/availability questions, call `schedule.get_day` first.
3. For client-specific questions, call `appointment.resolve_target` before message lookups.
4. For route questions, call `maps.plan_day` or `maps.estimate_leg`.
5. For weather questions, call `geo.geocode_address` then `weather.get_hourly`.
6. If route and weather are both requested, call `weather.assess_visit_risk`.
7. Compose one response with explicit sources and tool fallback notes.

## Guardrails
- Never answer schedule questions from model memory; always use `schedule.get_day`.
- Never answer client-history questions without scoped DB lookup.
- If external tools fail, return partial answer with explicit missing part.
- Include data freshness markers for external context (`fetchedAt`).
- Keep PII in tool outputs minimal and only for authorized caregiver scope.

## Error Contract
Tool-level standard:
```json
{
  "ok": false,
  "errorCode": "UPSTREAM_UNAVAILABLE|INVALID_INPUT|NOT_FOUND|UNAUTHORIZED|TIMEOUT",
  "message": "human-readable message",
  "retryable": true
}
```

Command endpoint behavior:
- If at least one core tool succeeds, return `200` with `mode: "ANSWERED"` and degraded guidance.
- Use `4xx/5xx` only for hard failures where no safe answer can be produced.

## Incremental Implementation Plan
1. Add `toolTrace` to command responses.
2. Normalize date parsing in command intent flow.
3. Add `geo.geocode_address` service wrapper with cache.
4. Add `weather.get_hourly` and `weather.assess_visit_risk`.
5. Add `context.day_brief` composer path for blended route+weather answers.
6. Add tests for fallback behavior (maps/weather down).

