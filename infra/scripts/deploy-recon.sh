#!/usr/bin/env bash
# Deploy the entire recon platform via Terraform (the sole deploy mechanism).
# Usage: ./infra/scripts/deploy-recon.sh [plan|apply|destroy]
set -euo pipefail

ACTION="${1:-plan}"
ENV_DIR="$(cd "$(dirname "$0")/../environments/recon" && pwd)"

cd "$ENV_DIR"

# The S3 state bucket name embeds the AWS account ID, so it is supplied via a gitignored
# partial-config file rather than committed in backend.tf. Fail loudly with an actionable
# message instead of letting `terraform init -input=false` error on a missing bucket.
if [[ ! -f backend.hcl ]]; then
  echo "ERROR: $ENV_DIR/backend.hcl is missing." >&2
  echo "       Copy backend.hcl.example to backend.hcl and set the state bucket name." >&2
  exit 1
fi

terraform init -input=false -backend-config=backend.hcl

case "$ACTION" in
  plan)    terraform plan -input=false ;;
  apply)   terraform apply -input=false -auto-approve ;;
  destroy) terraform destroy -input=false -auto-approve ;;
  *) echo "unknown action: $ACTION (use plan|apply|destroy)"; exit 1 ;;
esac

# Single apply deploys everything: the recon-agent container image is built AND pushed by
# CodeBuild during this apply (the build driver blocks until it succeeds, before the AgentCore
# Runtime is created), and the CloudFront domain + agent runtime ARN are wired in the same
# apply via Terraform's dependency graph. No second apply, no manual steps.
