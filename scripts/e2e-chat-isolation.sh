#!/usr/bin/env bash
set -euo pipefail

APPOINTMENT_API="${APPOINTMENT_API:-http://localhost:3001}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd curl
require_cmd jq

echo "==> Loading caregiver accounts"
curl -sS "${APPOINTMENT_API}/auth/accounts?role=CAREGIVER" >/tmp/ar_caregivers.json
CG1_USERNAME="$(jq -r '.data[0].username // empty' /tmp/ar_caregivers.json)"
CG2_USERNAME="$(jq -r '.data[1].username // empty' /tmp/ar_caregivers.json)"
CG1_USER_ID="$(jq -r '.data[0].userId // empty' /tmp/ar_caregivers.json)"
CG2_USER_ID="$(jq -r '.data[1].userId // empty' /tmp/ar_caregivers.json)"

if [[ -z "${CG1_USERNAME}" || -z "${CG2_USERNAME}" || -z "${CG1_USER_ID}" || -z "${CG2_USER_ID}" ]]; then
  echo "Need at least two caregiver accounts for isolation test."
  exit 1
fi

echo "==> Logging in caregivers"
CG1_TOKEN="$(
  curl -sS -X POST "${APPOINTMENT_API}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${CG1_USERNAME}\",\"password\":\"demo123\"}" | jq -r '.token'
)"
CG2_TOKEN="$(
  curl -sS -X POST "${APPOINTMENT_API}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${CG2_USERNAME}\",\"password\":\"demo123\"}" | jq -r '.token'
)"

if [[ "${CG1_TOKEN}" == "null" || "${CG2_TOKEN}" == "null" ]]; then
  echo "Failed to login caregivers."
  exit 1
fi

echo "==> Selecting one appointment for caregiver #1"
curl -sS "${APPOINTMENT_API}/appointments" \
  -H "Authorization: Bearer ${CG1_TOKEN}" >/tmp/ar_cg1_appointments.json
CG1_APPOINTMENT_ID="$(jq -r '.[0].id // empty' /tmp/ar_cg1_appointments.json)"
if [[ -z "${CG1_APPOINTMENT_ID}" ]]; then
  echo "No appointment found for caregiver #1."
  exit 1
fi
echo "Using appointment=${CG1_APPOINTMENT_ID}"

echo "==> Verifying caregiver #2 cannot read caregiver #1 messages"
READ_STATUS="$(
  curl -sS -o /tmp/ar_isolation_read.json -w "%{http_code}" \
    "${APPOINTMENT_API}/appointments/${CG1_APPOINTMENT_ID}/messages" \
    -H "Authorization: Bearer ${CG2_TOKEN}"
)"
if [[ "${READ_STATUS}" != "403" ]]; then
  echo "Expected 403 for read isolation, got ${READ_STATUS}"
  cat /tmp/ar_isolation_read.json
  exit 1
fi

echo "==> Verifying caregiver #2 cannot write caregiver #1 messages"
WRITE_STATUS="$(
  curl -sS -o /tmp/ar_isolation_write.json -w "%{http_code}" \
    -X POST "${APPOINTMENT_API}/messages" \
    -H "Authorization: Bearer ${CG2_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"appointmentId\":\"${CG1_APPOINTMENT_ID}\",\"content\":\"test unauthorized message\"}"
)"
if [[ "${WRITE_STATUS}" != "403" ]]; then
  echo "Expected 403 for write isolation, got ${WRITE_STATUS}"
  cat /tmp/ar_isolation_write.json
  exit 1
fi

echo "==> Verifying caregiver #2 cannot run caregiver #1 agent command"
AGENT_STATUS="$(
  curl -sS -o /tmp/ar_isolation_agent.json -w "%{http_code}" \
    -X POST "${APPOINTMENT_API}/agents/${CG1_USER_ID}/command" \
    -H "Authorization: Bearer ${CG2_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"command":"what is my schedule today?"}'
)"
if [[ "${AGENT_STATUS}" != "403" ]]; then
  echo "Expected 403 for agent workspace isolation, got ${AGENT_STATUS}"
  cat /tmp/ar_isolation_agent.json
  exit 1
fi

echo "Success: caregiver chat/agent isolation checks passed."
