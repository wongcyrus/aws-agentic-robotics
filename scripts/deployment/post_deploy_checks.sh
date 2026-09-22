#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Usage: post_deploy_checks.sh OUTPUT_FILE [--health] [--agentcore] [--timeout SECONDS]
EOF
}

error() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

[[ $# -ge 1 ]] || {
    usage
    exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_file=$1
shift
check_health=false
check_agentcore=false
timeout_seconds=20

while [[ $# -gt 0 ]]; do
    case "$1" in
        --health)
            check_health=true
            shift
            ;;
        --agentcore)
            check_agentcore=true
            shift
            ;;
        --timeout)
            [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || error "--timeout requires a positive integer."
            timeout_seconds=$2
            shift 2
            ;;
        *)
            usage
            error "unknown argument: $1"
            ;;
    esac
done

if [[ "$check_health" == false && "$check_agentcore" == false ]]; then
    exit 0
fi

validation_args=("$output_file")
if [[ "$check_health" == true ]]; then
    validation_args+=(
        --require-url humanoidRobotSimulatorServerlessUrl
        --require-url domainExpansionServerlessUrl
        --require-url textUrl
    )
fi
if [[ "$check_agentcore" == true ]]; then
    validation_args+=(--require-arn domainExpansionCommentatorRuntimeArn)
fi
"$script_dir/validate_cdk_output.sh" "${validation_args[@]}" >/dev/null

output_value() {
    jq -r --arg key "$1" 'to_entries[0].value[$key]' "$output_file"
}

if [[ "$check_health" == true ]]; then
    command -v curl >/dev/null 2>&1 || error "curl is required for post-deploy health checks."
    for key in \
        humanoidRobotSimulatorServerlessUrl \
        domainExpansionServerlessUrl \
        textUrl; do
        printf 'Checking deployed endpoint: %s\n' "$key"
        curl --fail --silent --show-error --location \
            --connect-timeout "$timeout_seconds" --max-time "$timeout_seconds" \
            --retry 2 --retry-delay 2 --retry-max-time "$((timeout_seconds * 3))" \
            "$(output_value "$key")" >/dev/null
    done
    echo "Website/API post-deploy checks passed."
fi

if [[ "$check_agentcore" == true ]]; then
    command -v aws >/dev/null 2>&1 || error "AWS CLI is required for the AgentCore invocation check."
    runtime_arn=$(output_value domainExpansionCommentatorRuntimeArn)
    session_id="deployment-health-check-$(date +%s)-$$-0000000000"
    echo "Invoking AgentCore runtime health prompt."
    AWS_PAGER='' aws bedrock-agentcore invoke-agent-runtime \
        --agent-runtime-arn "$runtime_arn" \
        --runtime-session-id "$session_id" \
        --content-type application/json \
        --accept application/json \
        --cli-binary-format raw-in-base64-out \
        --cli-connect-timeout "$timeout_seconds" \
        --cli-read-timeout "$timeout_seconds" \
        --payload '{"prompt":"Reply with OK to confirm runtime health.","session_id":"deployment-health-check"}' \
        /dev/null >/dev/null
    echo "AgentCore invocation check passed."
fi
