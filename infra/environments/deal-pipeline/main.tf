# Deal-pipeline demo root. Two modules: the shared Lambda packager and the demo's own resources.
# Contract: docs/deal-pipeline-design.md.

# Both handlers import the shared package as `from backend.deal_pipeline...`, so the zip must
# contain a top-level backend/ package; the module stages it that way.
#
# runtime_dependencies vendors exactly one pure-Python wheel: tzdata, the IANA database Python's
# zoneinfo falls back to when the runtime image ships none, so Date Arrived is computed in the desk
# time zone rather than silently in UTC. Everything else is boto3 (supplied by the Lambda runtime)
# and the standard library. `name` gives this root its own zip file name AND its own staging
# directory under the module path (.build/deal-pipeline-backend/), so this root and the recon root
# can be planned from one checkout without staging over each other: with one shared directory, a
# recon plan that followed an apply here zipped this root's tzdata-only tree for every recon Lambda.
module "lambda_package" {
  source               = "../../modules/lambda-package"
  name                 = "deal-pipeline-backend"
  backend_dir          = "${path.root}/../../../backend"
  runtime_dependencies = ["tzdata==2026.3"]
}

module "deal_pipeline" {
  source = "../../modules/deal-pipeline"

  name_prefix        = var.name_prefix
  agent_model_id     = var.agent_model_id
  memory_model_id    = var.memory_model_id
  log_retention_days = var.log_retention_days

  lambda_zip         = module.lambda_package.zip_path
  lambda_source_hash = module.lambda_package.source_code_hash

  # Seeds are read from this checkout: agent-blueprint/deal-pipeline-agent/{skills,prompts} and
  # data/security-master. Spelled out rather than left to the module default so a reader of this
  # file can see where the S3 content comes from.
  content_root = "${path.root}/../../.."
}
