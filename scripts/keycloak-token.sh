#!/usr/bin/env bash
# Prints an access token for a client of the local "wagering" realm (client_credentials grant).
# Client secrets are NOT stored in the repository: Keycloak generates them on realm import and this script reads
# the generated secret through the admin API using the local admin account.
#
#   TOKEN=$(scripts/keycloak-token.sh provider-a)
#   curl -H "Authorization: Bearer $TOKEN" ...
set -euo pipefail
CLIENT_ID="${1:?usage: keycloak-token.sh <provider-a|provider-b|backoffice>}"
KC="${KEYCLOAK_URL:-http://localhost:8080}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD (same value given to docker compose)}"

# First occurrence of a string field in a JSON document (no jq dependency).
json() { grep -o "\"$1\":\"[^\"]*\"" | head -n1 | sed -E "s/.*:\"([^\"]*)\"/\1/"; }

ADMIN_TOKEN=$(curl -sf -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${ADMIN_PASSWORD}" \
  "${KC}/realms/master/protocol/openid-connect/token" | json access_token)
INTERNAL_ID=$(curl -sf -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC}/admin/realms/wagering/clients?clientId=${CLIENT_ID}" | json id)
SECRET=$(curl -sf -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${KC}/admin/realms/wagering/clients/${INTERNAL_ID}/client-secret" | json value)
curl -sf -d grant_type=client_credentials -d "client_id=${CLIENT_ID}" --data-urlencode "client_secret=${SECRET}" \
  "${KC}/realms/wagering/protocol/openid-connect/token" | json access_token
