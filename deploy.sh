#!/usr/bin/env bash
set -euo pipefail

# Fix Docker credential helper issue that occurs in dev containers
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_HEALTH=false
CHECK_AGENTCORE=false
CHECK_TIMEOUT=20

usage() {
    cat <<'EOF'
Usage: ./deploy.sh [--check-health] [--check-agentcore] [--check-timeout SECONDS]

Post-deploy checks are disabled unless explicitly requested.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-health)
            CHECK_HEALTH=true
            shift
            ;;
        --check-agentcore)
            CHECK_AGENTCORE=true
            shift
            ;;
        --check-timeout)
            if [[ $# -lt 2 || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
                echo "❌ Error: --check-timeout requires a positive integer." >&2
                exit 2
            fi
            CHECK_TIMEOUT=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "❌ Error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

bash "${SCRIPT_DIR}/fix_docker_credentials.sh"

# Redirect all stdout and stderr to both the console and deploy.log
LOG_FILE="${SCRIPT_DIR}/deploy.log"
exec > >(tee "${LOG_FILE}") 2>&1
echo "📝 Deployment logs are being saved to: ${LOG_FILE}"

# Ensure ARM64 build emulation is active (only needed on AMD64 machines building ARM64 containers)
if ! docker run --rm --platform linux/arm64 alpine arch 2>/dev/null | grep -q "aarch64"; then
    echo "💡 [ARM64 Build Emulation Setup Required]"
    echo "Your host does not have ARM64 emulation active in Docker. If you are on an AMD64 machine:"
    echo " - On Ubuntu/Debian host: run 'sudo apt-get update && sudo apt-get install -y qemu-user-static binfmt-support'"
    echo " - Inside Dev Containers: ensure your devcontainer.json has postCreateCommand configured to install these packages."
    echo ""
    echo "🚀 Attempting automated fallback registration via privileged docker container..."
    docker run --privileged --rm tonistiigi/binfmt --install arm64 || true
else
    echo "✅ Docker ARM64 build emulation is active and verified."
fi

# Verify AWS credentials before deploying to avoid silent connection timeouts/hangs
echo "🔑 Verifying AWS credentials..."
if ! AWS_IDENTITY_OUT=$(aws sts get-caller-identity 2>&1); then
    echo "❌ Error: AWS credentials check failed!"
    echo "Detail: $AWS_IDENTITY_OUT"
    echo ""
    echo "Please run 'aws configure' or export your AWS credentials in your terminal before deploying."
    exit 1
fi

AWS_USER_ID=$(echo "$AWS_IDENTITY_OUT" | jq -r .UserId 2>/dev/null || aws sts get-caller-identity --query UserId --output text)

cd cdk
npx cdk deploy AwsAgenticRobotics --require-approval never --outputs-file output.json --context AwsUserId="$AWS_USER_ID"
"${SCRIPT_DIR}/scripts/deployment/validate_cdk_output.sh" output.json \
    --require RobotDataBucketName \
    --require ServerlessWebsiteBucket \
    --require DomainExpansionWebsiteBucket
jq -S . output.json > output.sorted.json && mv output.sorted.json output.json

BUCKET=$(jq -r '.[].RobotDataBucketName' output.json)
aws s3 sync s3://"$BUCKET"/iot-certificates/ ../robot_client/certificates

WEBSITE_BUCKET=$(jq -r '.[].ServerlessWebsiteBucket' output.json)
aws s3 sync ../humanoid-robot-simulator-serverless/frontend/video s3://"$WEBSITE_BUCKET"/video

DOMAIN_WEBSITE_BUCKET=$(jq -r '.[].DomainExpansionWebsiteBucket' output.json)
aws s3 sync ../domain-expansion-ar-game/static/video s3://"$DOMAIN_WEBSITE_BUCKET"/static/video

post_deploy_args=(output.json --timeout "$CHECK_TIMEOUT")
if [[ "$CHECK_HEALTH" == true ]]; then
    post_deploy_args+=(--health)
fi
if [[ "$CHECK_AGENTCORE" == true ]]; then
    post_deploy_args+=(--agentcore)
fi
"${SCRIPT_DIR}/scripts/deployment/post_deploy_checks.sh" "${post_deploy_args[@]}"