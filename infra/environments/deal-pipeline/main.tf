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

# Console-wide settings for the local demo: the SSM layer the console's Settings screen reads and
# writes, under /<name_prefix>/console, seeded from the same values env_local renders so the stored
# layer and .env.local agree on day one and the module then owns nothing but the parameters'
# existence (values are ignored after creation; see the module header). The recon groups are blank
# ON PURPOSE -- the recon stack is a separate root and is not deployed by this one -- and a blank
# seed creates no parameter, so this root creates four: the pipeline admin group, the enablement
# flag, the default model and the label. The pipeline access group is blank too (open, as env_local
# says), so an operator who wants to try restricting it does so in the UI, and the value they store
# stands across every later apply. No IAM here: the BFF runs on the developer's laptop with the
# developer's own credentials; the deployed console's grant is built by modules/frontend-ecs.
module "console_settings" {
  source = "../../modules/console-settings"

  prefix = "/${var.name_prefix}/console"

  recon_access_group    = ""
  recon_admin_group     = ""
  pipeline_access_group = local.pipeline_access_group
  pipeline_admin_group  = local.pipeline_admin_group
  pipeline_enabled      = true
  default_model_id      = var.agent_model_id
  organization_label    = var.console_organization_label
}
