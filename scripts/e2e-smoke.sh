#!/usr/bin/env bash
set -euo pipefail

APPOINTMENT_API="${APPOINTMENT_API:-http://localhost:3001}"
INGESTION_API="${INGESTION_API:-http://localhost:3005}"
SIMULATED_TODAY="${SIMULATED_TODAY:-2026-02-18}"
SUBSET_SIZE="${SUBSET_SIZE:-2}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd curl
require_cmd jq

echo "==> [1/10] Ingesting Excel sample data"
curl -sS -X POST "${INGESTION_API}/ingest/excel" \
  -H "Content-Type: application/json" \
  -d '{"appointmentsFile":"Appointment List_20260205031742.xlsx","clientFile":"Appointment Billing Info_202602.xlsx","staffFile":"Staff List_20260220110549.xlsx"}' \
  >/tmp/ar_ingest.json
jq '.summary' /tmp/ar_ingest.json

echo "==> [2/10] Loading auth accounts"
curl -sS "${APPOINTMENT_API}/auth/accounts" >/tmp/ar_accounts.json
CAREGIVER_USERNAME="$(jq -r '.data[] | select(.role=="CAREGIVER") | .username' /tmp/ar_accounts.json | head -n1)"
CAREGIVER_USER_ID="$(jq -r '.data[] | select(.role=="CAREGIVER") | .userId' /tmp/ar_accounts.json | head -n1)"
FAMILY_USERNAME="$(jq -r '.data[] | select(.role=="FAMILY") | .username' /tmp/ar_accounts.json | head -n1)"

if [[ -z "${CAREGIVER_USERNAME}" || -z "${FAMILY_USERNAME}" || -z "${CAREGIVER_USER_ID}" ]]; then
  echo "Failed to find caregiver/family accounts after ingestion."
  exit 1
fi
echo "Using caregiver=${CAREGIVER_USERNAME}, family=${FAMILY_USERNAME}"

echo "==> [3/10] Logging in caregiver and family"
CAREGIVER_TOKEN="$(
  curl -sS -X POST "${APPOINTMENT_API}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${CAREGIVER_USERNAME}\",\"password\":\"demo123\"}" | jq -r '.token'
)"
FAMILY_TOKEN="$(
  curl -sS -X POST "${APPOINTMENT_API}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${FAMILY_USERNAME}\",\"password\":\"demo123\"}" | jq -r '.token'
)"

if [[ "${CAREGIVER_TOKEN}" == "null" || "${FAMILY_TOKEN}" == "null" ]]; then
  echo "Login failed for caregiver or family."
  exit 1
fi

echo "==> [4/10] Selecting a caregiver appointment"
curl -sS "${APPOINTMENT_API}/appointments" \
  -H "Authorization: Bearer ${CAREGIVER_TOKEN}" >/tmp/ar_appointments.json
APPOINTMENT_ID="$(jq -r '.[0].id' /tmp/ar_appointments.json)"

if [[ "${APPOINTMENT_ID}" == "null" || -z "${APPOINTMENT_ID}" ]]; then
  echo "No appointments available for caregiver."
  exit 1
fi
echo "Selected appointment=${APPOINTMENT_ID}"

echo "==> [5/10] Lifecycle transitions (SCHEDULED -> IN_PROGRESS -> COMPLETED)"
curl -sS -X PUT "${APPOINTMENT_API}/appointments/${APPOINTMENT_ID}/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_PROGRESS"}' | jq '.data'
curl -sS -X PUT "${APPOINTMENT_API}/appointments/${APPOINTMENT_ID}/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"COMPLETED"}' | jq '.data'

echo "==> [6/10] Sending chat messages to trigger AI + readiness analysis"
curl -sS -X POST "${APPOINTMENT_API}/messages" \
  -H "Authorization: Bearer ${CAREGIVER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"appointmentId\":\"${APPOINTMENT_ID}\",\"content\":\"Access is not available yet, the code failed.\"}" \
  >/tmp/ar_msg1.json
curl -sS -X POST "${APPOINTMENT_API}/messages" \
  -H "Authorization: Bearer ${FAMILY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"appointmentId\":\"${APPOINTMENT_ID}\",\"content\":\"Meds and supplies are ready now.\"}" \
  >/tmp/ar_msg2.json

sleep 2
curl -sS "${APPOINTMENT_API}/appointments/${APPOINTMENT_ID}/readiness" | jq '{status, checks}'

echo "==> [7/10] Starting delegation and forcing one AI handoff cycle"
curl -sS -X POST "${APPOINTMENT_API}/agents/${CAREGIVER_USER_ID}/delegations/start" \
  -H "Authorization: Bearer ${CAREGIVER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"appointmentId\":\"${APPOINTMENT_ID}\",\"objective\":\"Collect blockers and keep family informed.\",\"durationMinutes\":30,\"questions\":[\"Any access issues?\",\"Are medications and supplies ready?\"],\"forceStart\":true}" \
  | jq '.data.appointmentId, .data.active'

curl -sS -X POST "${APPOINTMENT_API}/messages" \
  -H "Authorization: Bearer ${FAMILY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"appointmentId\":\"${APPOINTMENT_ID}\",\"content\":\"We have the key now and instructions are current.\"}" \
  >/tmp/ar_msg3.json
sleep 2

echo "==> [8/10] Ending delegation and validating summary history"
curl -sS -X POST "${APPOINTMENT_API}/agents/${CAREGIVER_USER_ID}/delegations/${APPOINTMENT_ID}/stop" \
  -H "Authorization: Bearer ${CAREGIVER_TOKEN}" | jq '.data.summaryGeneratedAt'
curl -sS "${APPOINTMENT_API}/agents/${CAREGIVER_USER_ID}/summaries" \
  -H "Authorization: Bearer ${CAREGIVER_TOKEN}" | jq '.data | length'

echo "==> [9/10] Running simulated next-day ingestion"
curl -sS -X POST "${INGESTION_API}/ingest/simulate/day" \
  -H "Content-Type: application/json" \
  -d "{\"simulatedToday\":\"${SIMULATED_TODAY}\",\"subsetSize\":${SUBSET_SIZE}}" \
  | jq '{status, targetDate, ingested, failed}'

echo "==> [10/10] Smoke flow completed"
echo "Success: ingestion, auth, lifecycle transitions, chat/readiness, delegation summaries, and daily simulation all executed."
