#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_dir="$repo_root/scripts/deployment/tests/.work"
validator="$repo_root/scripts/deployment/validate_cdk_output.sh"
loader="$repo_root/load_cdkstack_env.sh"
checks="$repo_root/scripts/deployment/post_deploy_checks.sh"

rm -rf "$work_dir"
mkdir -p "$work_dir/bin"
trap 'rm -rf "$work_dir"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_fails() {
    if "$@" >"$work_dir/stdout" 2>"$work_dir/stderr"; then
        fail "command unexpectedly succeeded: $*"
    fi
}

cat >"$work_dir/valid.json" <<'EOF'
{
  "Stack": {
    "RobotDataBucketName": "robot-data",
    "ServerlessWebsiteBucket": "website-data",
    "DomainExpansionWebsiteBucket": "domain-data",
    "humanoidRobotSimulatorServerlessUrl": "https://robot.example.test",
    "domainExpansionServerlessUrl": "https://domain.example.test",
    "textUrl": "https://api.example.test/index",
    "domainExpansionCommentatorRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/commentator_abc",
    "SAFE_VALUE": "spaces, quotes ' \" and $(touch should-not-run)"
  }
}
EOF

"$validator" "$work_dir/valid.json" \
    --require RobotDataBucketName \
    --require-url textUrl \
    --require-arn domainExpansionCommentatorRuntimeArn >/dev/null

printf '{"One":{"RobotDataBucketName":"x"},"Two":{"RobotDataBucketName":"y"}}\n' >"$work_dir/two.json"
assert_fails "$validator" "$work_dir/two.json"
grep -q "invalid CDK output schema" "$work_dir/stderr" || fail "invalid schema error was not explicit"

printf '{"Stack":{"RobotDataBucketName":"x"}}\n' >"$work_dir/missing.json"
assert_fails "$validator" "$work_dir/missing.json" --require ServerlessWebsiteBucket
grep -q "required CDK output is missing or empty: ServerlessWebsiteBucket" "$work_dir/stderr" ||
    fail "missing key error was not explicit"

printf '{"Stack":{"BAD-NAME":"value"}}\n' >"$work_dir/unsafe-key.json"
assert_fails "$validator" "$work_dir/unsafe-key.json"

(
    cd "$work_dir"
    CDK_OUTPUT_FILE="$work_dir/valid.json"
    source "$loader"
    [[ "$RobotDataBucketName" == "robot-data" ]] || fail "bucket output was not loaded"
    [[ "$SAFE_VALUE" == 'spaces, quotes '"'"' " and $(touch should-not-run)' ]] ||
        fail "special characters were not preserved"
    [[ ! -e should-not-run ]] || fail "output value was evaluated as shell code"
)

(
    CDK_OUTPUT_FILE="$work_dir/missing.json"
    if source "$loader" >"$work_dir/load-stdout" 2>"$work_dir/load-stderr"; then
        fail "loader accepted a file without required outputs"
    fi
    echo "sourcing continued after loader failure" >"$work_dir/source-continued"
)
[[ -s "$work_dir/source-continued" ]] || fail "loader failure exited the sourcing shell"

cat >"$work_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${@: -1}" >>"${CHECK_CALLS:?}"
EOF
cat >"$work_dir/bin/aws" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${CHECK_CALLS:?}"
EOF
chmod +x "$work_dir/bin/curl" "$work_dir/bin/aws"

CHECK_CALLS="$work_dir/no-calls" PATH="$work_dir/bin:$PATH" \
    "$checks" "$work_dir/missing.json"
[[ ! -e "$work_dir/no-calls" ]] || fail "default post-deploy checks performed network calls"

CHECK_CALLS="$work_dir/calls" PATH="$work_dir/bin:$PATH" \
    "$checks" "$work_dir/valid.json" --health --agentcore --timeout 3 >/dev/null
[[ $(wc -l <"$work_dir/calls") -eq 4 ]] || fail "expected three HTTP checks and one AgentCore check"
grep -q "invoke-agent-runtime" "$work_dir/calls" || fail "AgentCore invocation was not attempted"
if grep -q "SAFE_VALUE" "$work_dir/calls"; then
    fail "unrelated output values were exposed to checks"
fi

echo "All deployment output safety tests passed."
