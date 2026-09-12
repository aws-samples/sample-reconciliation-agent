# Run from this module's directory: `terraform init && terraform test`.
#
# PLAN-ONLY under mocked providers, for the reasons app_wiring.tftest.hcl gives (two local-exec
# provisioners; private_vpc = true skips the data sources and CloudFront). The required inputs are
# repeated here rather than shared because test files are independent of each other.
#
# What is under test is the CONSOLE-SETTINGS wiring: the three CONSOLE_* variables reach the task
# whether or not the pipeline app is deployed, the task role may manage exactly the parameters under
# the prefix (with a literal region and account, because DeleteParameter is in the grant), a blank
# prefix grants nothing while keeping the environment's shape, and a malformed prefix fails at plan.

mock_provider "aws" {
  override_during = plan

  override_resource {
    target = aws_ecr_repository.frontend
    values = {
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/frontend-test"
    }
  }
}

mock_provider "null" {}

variables {
  name_prefix  = "frontend-test"
  region       = "us-east-1"
  account_id   = "123456789012"
  frontend_dir = "tests/fixtures/no-such-frontend"
  vpc_id       = "vpc-00000000000000000"

  private_vpc                   = true
  private_subnet_ids            = ["subnet-00000000000000001", "subnet-00000000000000002"]
  vpc_cidr                      = "10.0.0.0/16"
  ecs_private_security_group_id = "sg-00000000000000000"

  recon_api_base    = "https://api.example.test"
  cognito_hosted_ui = "login.example.test"
  cognito_client_id = "client"

  cases_table          = "frontend-test-cases"
  cases_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-cases"
  audit_table          = "frontend-test-audit"
  audit_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-audit"
  assets_bucket        = "frontend-test-assets"
  assets_bucket_arn    = "arn:aws:s3:::frontend-test-assets"
  lessons_table        = "frontend-test-lessons"
  lessons_table_arn    = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-lessons"
  tier1_enabled_param  = "/frontend-test/tier1-enabled"
  harness_service_name = "harness_frontend_test.DEFAULT"

  console_settings_prefix    = "/frontend-test/console"
  console_admin_group        = "console-admins"
  console_organization_label = "Fictional Ops Console"

  # The exact actions the console's settings store issues against the prefix. Test-only, so the set
  # is written once and both grant runs assert against it.
  console_scoped_actions = [
    "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
    "ssm:PutParameter", "ssm:DeleteParameter",
  ]
}

# pipeline_enabled is left at its default (false): the layer sits ABOVE the apps, so a recon-only
# console must carry it exactly as a two-app console does.
run "console_variables_are_always_in_the_task_environment" {
  command = plan

  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["CONSOLE_SETTINGS_PREFIX"] == "/frontend-test/console"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["CONSOLE_ADMIN_GROUP"] == "console-admins"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["CONSOLE_ORGANIZATION_LABEL"] == "Fictional Ops Console"
    )
    error_message = "CONSOLE_SETTINGS_PREFIX, CONSOLE_ADMIN_GROUP and CONSOLE_ORGANIZATION_LABEL must be in the task environment with the module inputs' values, pipeline deployed or not"
  }

  # A duplicated name in an ECS environment is last-one-wins with no warning.
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]) == length(distinct([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]))
    error_message = "no environment variable name may appear twice in the task definition"
  }
}

run "the_task_role_may_manage_exactly_the_console_prefix" {
  command = plan

  # One statement carries DeleteParameter, and it names the prefix path and the parameters under it
  # -- nothing wider. The path itself is what GetParametersByPath authorizes on.
  assert {
    condition = toset(flatten(one([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : flatten([s.Resource])
      if contains(flatten([s.Action]), "ssm:DeleteParameter")
      ]))) == toset([
      "arn:aws:ssm:us-east-1:123456789012:parameter/frontend-test/console",
      "arn:aws:ssm:us-east-1:123456789012:parameter/frontend-test/console/*",
    ])
    error_message = "the console-settings statement must name exactly parameter<prefix> and parameter<prefix>/*, with the task's literal region and account (a delete grant must not use arn:aws:ssm:*:*)"
  }

  assert {
    condition = toset(flatten(one([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : flatten([s.Action])
      if contains(flatten([s.Action]), "ssm:DeleteParameter")
    ]))) == toset(var.console_scoped_actions)
    error_message = "the console-settings statement must grant GetParameter, GetParameters, GetParametersByPath, PutParameter and DeleteParameter, and nothing else"
  }

  # No statement in the whole policy grants an SSM delete on anything other than the console prefix.
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : [
        for r in flatten([s.Resource]) : startswith(r, "arn:aws:ssm:us-east-1:123456789012:parameter/frontend-test/console")
      ] if contains(flatten([s.Action]), "ssm:DeleteParameter")
    ]))
    error_message = "ssm:DeleteParameter may reach the console-settings prefix and nothing else"
  }
}

run "a_blank_prefix_disables_the_layer_without_changing_the_environment_shape" {
  command = plan

  variables {
    console_settings_prefix = ""
  }

  # The variable is still emitted, empty: the console treats blank as "layer off", and a task
  # definition that omitted the name would behave the same while reading differently to an auditor.
  assert {
    condition = (
      contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], "CONSOLE_SETTINGS_PREFIX")
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["CONSOLE_SETTINGS_PREFIX"] == ""
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["CONSOLE_ADMIN_GROUP"] == "console-admins"
    )
    error_message = "with a blank prefix CONSOLE_SETTINGS_PREFIX must still be present (empty) beside CONSOLE_ADMIN_GROUP and CONSOLE_ORGANIZATION_LABEL"
  }

  # ... but the grant is gone entirely. An empty prefix rendered into the ARN would have been
  # "parameter/*": every parameter in the account, with DeleteParameter among the actions.
  assert {
    condition = !anytrue([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      contains(flatten([s.Action]), "ssm:DeleteParameter") || contains(flatten([s.Action]), "ssm:GetParametersByPath") || contains(flatten([s.Action]), "ssm:DescribeParameters")
    ])
    error_message = "with a blank prefix the task policy must carry no console-settings statement at all"
  }
}

run "prefix_with_a_trailing_slash_fails_at_plan" {
  command = plan

  variables {
    console_settings_prefix = "/frontend-test/console/"
  }

  expect_failures = [var.console_settings_prefix]
}

run "prefix_without_a_leading_slash_fails_at_plan" {
  command = plan

  variables {
    console_settings_prefix = "frontend-test/console"
  }

  expect_failures = [var.console_settings_prefix]
}
