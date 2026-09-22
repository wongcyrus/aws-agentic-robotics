#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Usage: validate_cdk_output.sh OUTPUT_FILE [--require KEY] [--require-url KEY] [--require-arn KEY]
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

output_file=$1
shift

required_keys=()
url_keys=()
arn_keys=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --require|--require-url|--require-arn)
            [[ $# -ge 2 ]] || error "$1 requires an output key."
            case "$1" in
                --require) required_keys+=("$2") ;;
                --require-url) url_keys+=("$2") ;;
                --require-arn) arn_keys+=("$2") ;;
            esac
            shift 2
            ;;
        *)
            usage
            error "unknown argument: $1"
            ;;
    esac
done

command -v jq >/dev/null 2>&1 || error "jq is required to validate CDK outputs."
[[ -r "$output_file" ]] || error "CDK output file is not readable: $output_file"

if ! jq -e '
    type == "object" and
    length == 1 and
    (to_entries[0].key | type == "string" and length > 0) and
    (to_entries[0].value | type == "object") and
    (to_entries[0].value | to_entries | all(
        (.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) and
        (.value | type == "string" and length > 0 and (test("[\u0000-\u001f\u007f]") | not))
    ))
' "$output_file" >/dev/null 2>&1; then
    error "invalid CDK output schema in $output_file; expected one stack with non-empty, shell-safe string outputs."
fi

for key in "${required_keys[@]}" "${url_keys[@]}" "${arn_keys[@]}"; do
    [[ -n "$key" ]] || continue
    if ! jq -e --arg key "$key" 'to_entries[0].value[$key] | type == "string" and length > 0' \
        "$output_file" >/dev/null; then
        error "required CDK output is missing or empty: $key"
    fi
done

for key in "${url_keys[@]}"; do
    if ! jq -e --arg key "$key" \
        'to_entries[0].value[$key] | test("^https://[^[:space:]]+$")' \
        "$output_file" >/dev/null; then
        error "CDK output must be a valid HTTPS URL: $key"
    fi
done

for key in "${arn_keys[@]}"; do
    if ! jq -e --arg key "$key" \
        'to_entries[0].value[$key] | test("^arn:(aws|aws-us-gov|aws-cn):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime/[A-Za-z0-9_-]+$")' \
        "$output_file" >/dev/null; then
        error "CDK output must be a valid AgentCore runtime ARN: $key"
    fi
done

printf 'CDK output validation passed: %s\n' "$output_file"
