# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under a MOCKED AWS provider: nothing is created and no credentials are read. The two
# data sources are overridden so the ARN-prefix output is known at plan time.
#
# What is under test is the contract with the frontend (chatbot-app/frontend/src/lib/console/
# types.ts): every parameter sits at exactly the key the console reads, a blank seed creates nothing
# rather than a placeholder the console would read as stored, and the prefix is refused in the two
# shapes that apply cleanly and break the task role's grant.

mock_provider "aws" {
  override_data {
    target = data.aws_region.current
    values = {
      region = "us-east-1"
    }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }
}

variables {
  prefix                = "/console-test/console"
  recon_access_group    = "recon-users"
  recon_admin_group     = "recon-admins"
  pipeline_access_group = "deal-desk"
  pipeline_admin_group  = "deal-desk-admins"
  pipeline_enabled      = true
  default_model_id      = "us.anthropic.claude-sonnet-5"
  organization_label    = "Fictional Ops Console"
}

run "every_non_blank_seed_becomes_a_parameter_at_its_contract_key" {
  command = plan

  # The full set, spelled out: a typo in a key here would still create a parameter and the console
  # would read nothing from it, so the names are asserted literally rather than derived.
  assert {
    condition = toset([for p in aws_ssm_parameter.setting : p.name]) == toset([
      "/console-test/console/access/recon/access-group",
      "/console-test/console/access/recon/admin-group",
      "/console-test/console/access/pipeline/access-group",
      "/console-test/console/access/pipeline/admin-group",
      "/console-test/console/apps/pipeline/enabled",
      "/console-test/console/defaults/model-id",
      "/console-test/console/defaults/organization-label",
    ])
    error_message = "with every seed set, exactly the seven contract keys must be created under the prefix; got ${jsonencode([for p in aws_ssm_parameter.setting : p.name])}"
  }

  assert {
    condition     = alltrue([for p in aws_ssm_parameter.setting : p.type == "String"])
    error_message = "every console setting is a plain String parameter: the console reads them without decryption and none is a secret"
  }

  # Each parameter carries its own seed -- the value the same root hands the task as an environment
  # variable -- so on day one the stored layer and the environment agree.
  assert {
    condition = (
      aws_ssm_parameter.setting["access/recon/access-group"].value == "recon-users"
      && aws_ssm_parameter.setting["access/recon/admin-group"].value == "recon-admins"
      && aws_ssm_parameter.setting["access/pipeline/access-group"].value == "deal-desk"
      && aws_ssm_parameter.setting["access/pipeline/admin-group"].value == "deal-desk-admins"
      && aws_ssm_parameter.setting["defaults/model-id"].value == "us.anthropic.claude-sonnet-5"
      && aws_ssm_parameter.setting["defaults/organization-label"].value == "Fictional Ops Console"
    )
    error_message = "each parameter must be seeded with the value of its own variable"
  }

  # The registry disables an app only on the exact string "false", so the bool must render as the
  # lowercase literal and nothing else.
  assert {
    condition     = aws_ssm_parameter.setting["apps/pipeline/enabled"].value == "true"
    error_message = "pipeline_enabled = true must be stored as the literal string \"true\""
  }

  assert {
    condition     = output.parameter_arn_prefix == "arn:aws:ssm:us-east-1:123456789012:parameter/console-test/console"
    error_message = "parameter_arn_prefix must be the SSM ARN of the prefix path itself (no trailing slash, no wildcard); got ${output.parameter_arn_prefix}"
  }

  assert {
    condition     = output.prefix == "/console-test/console" && length(output.skipped_settings) == 0
    error_message = "with every seed set nothing is skipped and the prefix output echoes the input"
  }
}

run "pipeline_disabled_is_stored_as_the_literal_false" {
  command = plan

  variables {
    pipeline_enabled = false
  }

  # "false" is a non-blank value and is stored: a recon-only console needs the stored layer to say
  # the app is off, not to fall through to whatever the environment happens to say.
  assert {
    condition     = aws_ssm_parameter.setting["apps/pipeline/enabled"].value == "false"
    error_message = "pipeline_enabled = false must create the enabled parameter with the literal string \"false\", not skip it"
  }
}

run "blank_seeds_are_skipped_not_written_as_placeholders" {
  command = plan

  # A pipeline-only shape: no recon group named, and the pipeline access group deliberately open.
  variables {
    recon_access_group    = ""
    recon_admin_group     = "   "
    pipeline_access_group = ""
  }

  assert {
    condition = toset([for p in aws_ssm_parameter.setting : p.name]) == toset([
      "/console-test/console/access/pipeline/admin-group",
      "/console-test/console/apps/pipeline/enabled",
      "/console-test/console/defaults/model-id",
      "/console-test/console/defaults/organization-label",
    ])
    error_message = "a blank or whitespace-only seed must create no parameter: a placeholder value would be read by the console as stored and outrank the environment; got ${jsonencode([for p in aws_ssm_parameter.setting : p.name])}"
  }

  # The plan output tells the operator which settings the UI will have to create on first save.
  assert {
    condition     = output.skipped_settings == tolist(["access/pipeline/access-group", "access/recon/access-group", "access/recon/admin-group"])
    error_message = "skipped_settings must list exactly the blank seeds, sorted; got ${jsonencode(output.skipped_settings)}"
  }
}

run "seeds_are_trimmed_before_they_are_stored" {
  command = plan

  variables {
    recon_access_group = "  recon-users  "
    organization_label = " Fictional Ops Console "
  }

  # The console trims a group before comparing it to the token's claim. A stored value with padding
  # would show in the Settings screen as something different from what the proxy actually checks.
  assert {
    condition = (
      aws_ssm_parameter.setting["access/recon/access-group"].value == "recon-users"
      && aws_ssm_parameter.setting["defaults/organization-label"].value == "Fictional Ops Console"
    )
    error_message = "group and label seeds must be stored trimmed"
  }
}

# The task role's grant is "parameter<prefix>" and "parameter<prefix>/*". A trailing slash makes the
# second "parameter<prefix>//*", which matches nothing; the apply would succeed and every Settings
# request would be denied.
run "prefix_with_a_trailing_slash_fails_at_plan" {
  command = plan

  variables {
    prefix = "/console-test/console/"
  }

  expect_failures = [var.prefix]
}

# SSM parameter names in a hierarchy start with "/"; without it the name is rejected at apply, and
# the console would be appending keys to a prefix that names nothing.
run "prefix_without_a_leading_slash_fails_at_plan" {
  command = plan

  variables {
    prefix = "console-test/console"
  }

  expect_failures = [var.prefix]
}

# The seeds obey the same limits the Settings screen enforces on a PUT, so a seed is never a value
# the operator could not re-save from the UI.
run "a_seed_the_console_would_refuse_fails_at_plan" {
  command = plan

  variables {
    recon_access_group = "recon#users"
    organization_label = "This organization label is far too long for the rail to show it whole"
  }

  expect_failures = [var.recon_access_group, var.organization_label]
}
