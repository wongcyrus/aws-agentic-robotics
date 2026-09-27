#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/cdk/output.json"
V2_OUTPUT_FILE="${SCRIPT_DIR}/cdk/output-domain-v2.json"

if [[ ! -f "$OUTPUT_FILE" ]]; then
    echo "Missing $OUTPUT_FILE. Deploy V1 first so shared service identifiers are available." >&2
    exit 1
fi

aws sts get-caller-identity >/dev/null

read_output() {
    jq -er --arg key "$1" 'to_entries[0].value[$key]' "$OUTPUT_FILE"
}

read_matching_output() {
    jq -er --arg fragment "$1" '
        to_entries[0].value
        | to_entries
        | map(select(.key | contains($fragment)))
        | if length == 1 then .[0].value else error("Expected one matching output") end
    ' "$OUTPUT_FILE"
}

USER_POOL_ID="$(read_output CognitoUserPoolId)"
USER_POOL_CLIENT_ID="$(read_output CognitoUserPoolClientId)"
COMMENTATOR_RUNTIME_ARN="$(read_output domainExpansionCommentatorRuntimeArn)"
ROBOT_API_ENDPOINT="$(read_output humanoidRobotSimulatorServerlessUrl)"
ROBOT_GATEWAY_URL="$(read_matching_output RobotToolGatewayUrl)"
OPENCLAW_RUNTIME_ARN="$(aws ssm get-parameter \
    --name /openclaw/agentcore/runtime-arn-dev \
    --query Parameter.Value \
    --output text)"

npm --prefix "${SCRIPT_DIR}/domain-expansion-ar-game-v2" ci
npm --prefix "${SCRIPT_DIR}/domain-expansion-ar-game-v2" run build

cd "${SCRIPT_DIR}/cdk"
context=(
    --context OnlyDomainV2=true
    --context DomainV2UserPoolId="$USER_POOL_ID"
    --context DomainV2UserPoolClientId="$USER_POOL_CLIENT_ID"
    --context DomainV2CommentatorRuntimeArn="$COMMENTATOR_RUNTIME_ARN"
    --context DomainV2OpenClawRuntimeArn="$OPENCLAW_RUNTIME_ARN"
    --context DomainV2RobotApiEndpoint="$ROBOT_API_ENDPOINT"
    --context DomainV2RobotGatewayUrl="$ROBOT_GATEWAY_URL"
)

npx cdk synth DomainExpansionV2 --strict "${context[@]}" >/dev/null
npx cdk diff DomainExpansionV2 "${context[@]}"
npx cdk deploy DomainExpansionV2 \
    --require-approval never \
    --outputs-file "$V2_OUTPUT_FILE" \
    "${context[@]}"

V2_BUCKET="$(jq -er 'to_entries[0].value.DomainExpansionV2WebsiteBucket' "$V2_OUTPUT_FILE")"
aws s3 sync \
    "${SCRIPT_DIR}/domain-expansion-ar-game/static/video" \
    "s3://${V2_BUCKET}/static/video"

V2_URL="$(jq -er 'to_entries[0].value.DomainExpansionV2Url' "$V2_OUTPUT_FILE")"
curl --fail --silent --show-error "${V2_URL}/health" >/dev/null
echo "Domain Expansion V2 deployed: ${V2_URL}"
