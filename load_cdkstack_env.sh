#!/usr/bin/env bash
# Load the single CDK stack's outputs into environment variables

_load_cdkstack_env_main() {
  local script_dir json_file key encoded value
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  json_file="${CDK_OUTPUT_FILE:-$script_dir/cdk/output.json}"

  if ! command -v base64 >/dev/null 2>&1; then
    echo "Error: base64 is required to load CDK stack outputs." >&2
    return 1
  fi

  "$script_dir/scripts/deployment/validate_cdk_output.sh" "$json_file" \
    --require RobotDataBucketName \
    --require ServerlessWebsiteBucket \
    --require DomainExpansionWebsiteBucket || return 1

  while IFS=$'\t' read -r key encoded; do
    if ! value=$(printf '%s' "$encoded" | base64 --decode); then
      echo "Error: failed to decode CDK output: $key" >&2
      return 1
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done < <(jq -r 'to_entries[0].value | to_entries[] | [.key, (.value | @base64)] | @tsv' "$json_file")

  echo "CDK stack environment variables loaded."
}

_load_cdkstack_env_main
_load_cdkstack_env_status=$?
unset -f _load_cdkstack_env_main
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  exit "$_load_cdkstack_env_status"
fi
if [[ "$_load_cdkstack_env_status" -eq 0 ]]; then
  unset _load_cdkstack_env_status
  return 0
fi
unset _load_cdkstack_env_status
return 1
