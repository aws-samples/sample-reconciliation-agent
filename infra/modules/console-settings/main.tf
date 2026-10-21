####################################################################################
# Console-wide settings: the configuration layer ABOVE the two apps.
#
# One SSM String parameter per setting under var.prefix, at exactly the keys the frontend contract
# fixes (chatbot-app/frontend/src/lib/console/types.ts): who may reach which app, whether the
# opt-in app is deployed, and the defaults an app may inherit. Per-app configuration (thresholds,
# the pipeline's model, contacts...) is NOT here: it stays in each app's Config tab and its own
# parameters, and this module must never grow a key for it.
#
# The frontend resolves every setting as stored (non-blank) -> environment -> default, so what is
# written here OUTRANKS the RECON_ACCESS_GROUP / PIPELINE_ENABLED / ... the same root sets on the
# ECS task. Seeding the parameters from the very variables that feed those environment variables is
# what keeps day one consistent: the two layers agree until an operator edits in the UI.
#
# Terraform creates; the UI owns. Every parameter carries ignore_changes on its value because the
# console's Settings screen writes these parameters at runtime (PutParameter with Overwrite), and
# an apply that reasserted the seed would silently undo an access change an operator made and
# verified in the UI. Terraform therefore manages the parameters' EXISTENCE and nothing else --
# which has two consequences worth knowing before editing the seeds:
#   * Clearing a value in the UI deletes the parameter (SSM has no empty string). Because this
#     module manages existence, the next apply re-creates it from the seed unless the seed in
#     tfvars is blanked as well. Clearing for good is therefore a two-step: clear in the UI, blank
#     the seed.
#   * A parameter the UI created first (its seed was blank at the time) cannot later be adopted by
#     giving the seed a value: the create fails with ParameterAlreadyExists, on purpose, rather
#     than overwriting the UI's value. Import it, or leave the seed blank -- the stored value
#     stands either way.
####################################################################################

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # Relative key -> seed value. The keys are the contract's, spelled once. Group and text seeds are
  # trimmed because the console trims a group before comparing it and a padded seed would render in
  # the Settings screen as a value that differs from what the proxy checks. The enablement flag is
  # rendered as the literal string the registry's isAppEnabled compares against.
  seeds = {
    "access/recon/access-group"    = trimspace(var.recon_access_group)
    "access/recon/admin-group"     = trimspace(var.recon_admin_group)
    "access/pipeline/access-group" = trimspace(var.pipeline_access_group)
    "access/pipeline/admin-group"  = trimspace(var.pipeline_admin_group)
    "apps/pipeline/enabled"        = var.pipeline_enabled ? "true" : "false"
    "defaults/model-id"            = trimspace(var.default_model_id)
    "defaults/organization-label"  = trimspace(var.organization_label)
  }

  # A blank seed creates NO parameter. SSM rejects an empty value, and any placeholder (a single
  # space, a sentinel word) would be read back by the frontend as a stored, non-blank value that
  # outranks the environment -- a blank seed would then LOCK the setting to the placeholder rather
  # than leave it to env/default. Skipping is the only representation of "nothing stored"; the UI
  # creates the parameter on the first save.
  seeded  = { for key, value in local.seeds : key => value if value != "" }
  skipped = sort([for key, value in local.seeds : key if value == ""])

  parameter_arn_prefix = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.prefix}"
}

resource "aws_ssm_parameter" "setting" {
  for_each = local.seeded

  name  = "${var.prefix}/${each.key}"
  type  = "String"
  value = each.value

  # No description and no tags beyond the provider's default_tags: the UI rewrites these with a bare
  # PutParameter, and any attribute set here that the UI does not echo back would show as drift on
  # every plan after the first edit.

  lifecycle {
    # The console UI owns the value after creation; see the header. Terraform seeds, never reverts.
    ignore_changes = [value]
  }
}
