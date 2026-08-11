#!/usr/bin/env bash
# In-apply container image build driver: stages the agent build context (agent modules +
# backend package), uploads it as the CodeBuild S3 source, starts the ARM64 CodeBuild build,
# and BLOCKS until it succeeds. Invoked by a terraform_data local-exec so a single
# `terraform apply` produces a pushed image before the AgentCore Runtime is created.
#
# Required env: AGENT_SRC, BACKEND_SRC, IMAGE_URI, ASSETS_BUCKET, CODEBUILD_PROJECT, AWS_REGION
set -euo pipefail

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "[build] staging container context in $STAGE"
# Agent top-level modules + skills + Dockerfile (build context root).
cp "$AGENT_SRC"/*.py "$AGENT_SRC/requirements.txt" "$AGENT_SRC/Dockerfile" "$STAGE/"
cp -R "$AGENT_SRC/skills" "$STAGE/skills"
# Shared backend package (Dockerfile does `COPY backend ./backend`).
mkdir -p "$STAGE/backend"
cp -R "$BACKEND_SRC"/. "$STAGE/backend/"
# The buildspec runs inside the unpacked source root.
cp "$(dirname "$0")/buildspec.yml" "$STAGE/buildspec.yml"

echo "[build] zipping + uploading source to s3://$ASSETS_BUCKET/builds/agent-src.zip"
( cd "$STAGE" && zip -qr /tmp/agent-src.zip . )
aws s3 cp /tmp/agent-src.zip "s3://$ASSETS_BUCKET/builds/agent-src.zip" --region "$AWS_REGION"
rm -f /tmp/agent-src.zip

# Retry the build up to 3 times: a freshly-created CodeBuild service-role policy can lag IAM
# propagation, causing the first build to fail at the QUEUED phase with a logs:CreateLogStream
# CLIENT_ERROR. Re-running once propagation catches up succeeds.
for attempt in 1 2 3; do
  echo "[build] starting CodeBuild project $CODEBUILD_PROJECT (attempt $attempt)"
  BUILD_ID="$(aws codebuild start-build \
    --project-name "$CODEBUILD_PROJECT" \
    --region "$AWS_REGION" \
    --query 'build.id' --output text)"
  echo "[build] build id: $BUILD_ID — waiting for completion"

  STATUS=IN_PROGRESS
  while [ "$STATUS" = "IN_PROGRESS" ]; do
    sleep 15
    STATUS="$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$AWS_REGION" \
      --query 'builds[0].buildStatus' --output text)"
  done

  if [ "$STATUS" = "SUCCEEDED" ]; then
    echo "[build] SUCCEEDED"
    exit 0
  fi

  echo "[build] attempt $attempt ended with status $STATUS" >&2
  [ "$attempt" -lt 3 ] && { echo "[build] retrying after IAM propagation delay..."; sleep 20; }
done
echo "[build] all attempts failed" >&2
exit 1
