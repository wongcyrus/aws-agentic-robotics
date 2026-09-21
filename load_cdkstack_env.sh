#!/bin/bash
# Load the single CDK stack's outputs into environment variables

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
json_file="$script_dir/cdk/output.json"

if ! command -v jq &> /dev/null; then
  echo "Error: jq is not installed. Please install jq to use this script."
  exit 1
fi

stack_count=$(jq 'length' "$json_file")
if [ "$stack_count" -ne 1 ]; then
  echo "Error: expected exactly one stack in $json_file, found $stack_count."
  exit 1
fi

export_cmds=$(jq -r 'to_entries[0].value | to_entries[] | "export " + .key + "=\"" + (.value|tostring) + "\""' "$json_file")

eval "$export_cmds"
echo "CDK stack environment variables loaded."
