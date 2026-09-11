# Run from this module's directory: `terraform init && terraform test`.
#
# PLAN-ONLY, and that is load-bearing: the module drives two local-exec provisioners (the frontend
# source upload and the CodeBuild trigger) that Terraform core -- not the mocked provider -- would run
# on apply, zipping a directory and calling the AWS CLI. A plan never runs a provisioner.
#
# private_vpc = true so the two data sources (default internet gateway, CloudFront prefix list) and
# the CloudFront/WAF resources are skipped; none of them bears on what is under test, which is the
# deal-pipeline WIRING: the environment the task gets and the grants the task role gets, with the
# app off (a recon-only console must be unchanged apart from being TOLD the app is off) and with it
# on.
#
# override_during = plan makes the overridden computed values known at plan time. Without it the
# ECR repository URL is unknown until apply, and because the container image is `<url>:<hash>` the
# whole container_definitions string -- the environment included -- is unknown and unassertable.

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
  name_prefix = "frontend-test"
  region      = "us-east-1"
  account_id  = "123456789012"
  # A directory that does not exist: fileset() yields nothing, so the source hash is the build
  # config alone and the run does not hash the real frontend tree.
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

  recon_access_group    = "recon-users"
  pipeline_access_group = "deal-desk"
  pipeline_admin_group  = "deal-desk-admins"

  # The environment names this module hands the pipeline BFF when the app is deployed. Not a module
  # variable -- a test-only value both runs below assert against, so the set is written once.
  pipeline_env_names = [
    "PIPELINE_ASSETS_BUCKET", "PIPELINE_AGENT_MODEL_PARAM", "PIPELINE_SKILLS_PREFIX",
    "EMAILS_TABLE", "DEALS_TABLE", "SKILL_PROPOSALS_TABLE",
    "KNOWLEDGE_MEMORY_ID", "CHAT_MEMORY_ID",
    "PARSER_FUNCTION", "OMS_UPLOAD_FUNCTION",
    "ASSISTANT_MODEL_ID", "PARSER_PROMPT_KEY", "PIPELINE_SAMPLES_PREFIX",
  ]

  # Every deal-pipeline resource, so a run only has to flip pipeline_enabled. Ignored while the app
  # is off: the environment and the grants that name them are gated on pipeline_enabled, which the
  # recon-only run below proves.
  pipeline_assets_bucket             = "frontend-test-pipeline-assets"
  pipeline_assets_bucket_arn         = "arn:aws:s3:::frontend-test-pipeline-assets"
  pipeline_emails_table              = "frontend-test-pipeline-emails"
  pipeline_emails_table_arn          = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-pipeline-emails"
  pipeline_deals_table               = "frontend-test-pipeline-deals"
  pipeline_deals_table_arn           = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-pipeline-deals"
  pipeline_skill_proposals_table     = "frontend-test-pipeline-skill-proposals"
  pipeline_skill_proposals_table_arn = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-pipeline-skill-proposals"
  pipeline_knowledge_memory_id       = "frontend_test_pipeline_knowledge-abc"
  pipeline_knowledge_memory_arn      = "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/frontend_test_pipeline_knowledge-abc"
  pipeline_chat_memory_id            = "frontend_test_pipeline_chat-def"
  pipeline_chat_memory_arn           = "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/frontend_test_pipeline_chat-def"
  pipeline_parser_function_name      = "frontend-test-pipeline-parser"
  pipeline_parser_function_arn       = "arn:aws:lambda:us-east-1:123456789012:function:frontend-test-pipeline-parser"
  pipeline_oms_upload_function_name  = "frontend-test-pipeline-oms-upload"
  pipeline_oms_upload_function_arn   = "arn:aws:lambda:us-east-1:123456789012:function:frontend-test-pipeline-oms-upload"
  pipeline_agent_model_param         = "/frontend-test-pipeline/agent-model-id"
  pipeline_agent_model_param_arn     = "arn:aws:ssm:us-east-1:123456789012:parameter/frontend-test-pipeline/agent-model-id"
  pipeline_assistant_model_id        = "us.anthropic.claude-sonnet-5"
}

run "recon_only_console_is_unchanged_apart_from_the_group_and_switch_variables" {
  command = plan

  # The three access-control names are always present: the proxy resolves every registered app
  # from them whether or not the pipeline is deployed, and "" is the documented open/nobody value.
  assert {
    condition = alltrue([
      for name in ["RECON_ACCESS_GROUP", "PIPELINE_ACCESS_GROUP", "PIPELINE_ADMIN_GROUP"] :
      contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], name)
    ])
    error_message = "RECON_ACCESS_GROUP, PIPELINE_ACCESS_GROUP and PIPELINE_ADMIN_GROUP must be in the task environment even when the pipeline app is not deployed"
  }

  # ... and so are the two switches, with the recon-only values. PIPELINE_ENABLED=false is what makes
  # the shell hide the app and refuse /api/pipeline/*; without it every authenticated user saw a Deal
  # Pipeline entry whose pages failed with a missing-variable 500. REQUIRE_ACCESS_GROUPS=false keeps a
  # blank access group open, which is what this console had before the rail existed.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_ENABLED"] == "false"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["REQUIRE_ACCESS_GROUPS"] == "false"
    )
    error_message = "a recon-only console must render PIPELINE_ENABLED=false and REQUIRE_ACCESS_GROUPS=false"
  }

  # Nothing pipeline-specific leaks into a recon-only console: not the environment ...
  assert {
    condition = length(setintersection(
      toset([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]),
      toset(var.pipeline_env_names),
    )) == 0
    error_message = "with pipeline_enabled = false none of the pipeline BFF variables may be set"
  }

  # ... nor the task role. The recon SKILLS_PREFIX/ASSETS_BUCKET grants are on recon's bucket, so the
  # only way a pipeline resource could appear here is through the pipeline statements.
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      [for r in flatten([s.Resource]) : strcontains(r, "deal-csv/") || strcontains(r, "samples/") || startswith(r, var.pipeline_assets_bucket_arn) || r == var.pipeline_emails_table_arn]
    ]))
    error_message = "with pipeline_enabled = false the task policy must carry no deal-pipeline grant"
  }

  # No SAMPLE_EMAILS_DIR in a container, on or off: a disk path reads as configured and lists nothing.
  assert {
    condition     = !contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], "SAMPLE_EMAILS_DIR")
    error_message = "SAMPLE_EMAILS_DIR must never be set on the ECS task"
  }
}

run "pipeline_enabled_without_its_arns_fails_at_plan" {
  command = plan

  variables {
    pipeline_enabled                   = true
    pipeline_assets_bucket_arn         = ""
    pipeline_emails_table_arn          = ""
    pipeline_deals_table_arn           = ""
    pipeline_skill_proposals_table_arn = ""
    pipeline_knowledge_memory_arn      = ""
    pipeline_chat_memory_arn           = ""
    pipeline_parser_function_arn       = ""
    pipeline_oms_upload_function_arn   = ""
    pipeline_agent_model_param_arn     = ""
  }

  expect_failures = [aws_iam_role_policy.ecs_task]
}

# Two apps behind one OIDC client with a blank access group would admit the whole deal desk to the
# recon app -- and recon has write routes gated by the access check alone. The plan refuses it, on
# the variable the operator flips, naming both groups.
run "pipeline_enabled_with_a_blank_recon_access_group_fails_at_plan" {
  command = plan

  variables {
    pipeline_enabled   = true
    recon_access_group = ""
  }

  expect_failures = [var.pipeline_enabled]
}

# Whitespace is blank too: the console trims the group before comparing, so the validation must not
# let "  " through as a configured group.
run "pipeline_enabled_with_a_whitespace_pipeline_access_group_fails_at_plan" {
  command = plan

  variables {
    pipeline_enabled      = true
    pipeline_access_group = "  "
  }

  expect_failures = [var.pipeline_enabled]
}

run "pipeline_console_gets_the_environment_and_matching_grants" {
  command = plan

  variables {
    pipeline_enabled = true
  }

  # Every documented BFF variable is present (the recon-only run above proves none of them is
  # present with the app off, so between the two runs enabling it adds exactly this set).
  assert {
    condition = length(setsubtract(
      toset(var.pipeline_env_names),
      toset([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]),
    )) == 0
    error_message = "enabling the pipeline must add every documented BFF variable to the task environment"
  }

  # Both switches flip together: the app is on, and a blank access group now fails closed.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_ENABLED"] == "true"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["REQUIRE_ACCESS_GROUPS"] == "true"
    )
    error_message = "a console with the pipeline deployed must render PIPELINE_ENABLED=true and REQUIRE_ACCESS_GROUPS=true"
  }

  # And only once each: a duplicated name in an ECS environment is last-one-wins with no warning.
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]) == length(distinct([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]))
    error_message = "no environment variable name may appear twice in the task definition"
  }

  # The prefixed names carry the PIPELINE values, and the recon names still carry recon's: this is
  # the collision the prefix exists for.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_ASSETS_BUCKET"] == "frontend-test-pipeline-assets"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["ASSETS_BUCKET"] == "frontend-test-assets"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_AGENT_MODEL_PARAM"] == "/frontend-test-pipeline/agent-model-id"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_SAMPLES_PREFIX"] == "samples/"
    )
    error_message = "the PIPELINE_-prefixed variables must carry the pipeline's values while the bare recon names keep recon's"
  }

  # Every S3 location the environment names is one the role can read: the skills prefix, the
  # samples prefix and the parser prompt key each fall under a GetObject resource on the PIPELINE
  # bucket -- the invariant modules/deal-pipeline keeps for its Lambdas, kept here for the console.
  assert {
    condition = alltrue([
      for location in [
        { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_SKILLS_PREFIX"],
        { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_SAMPLES_PREFIX"],
        { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PARSER_PROMPT_KEY"],
        ] : anytrue([
          for r in flatten([
            for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s.Resource
            if contains(s.Action, "s3:GetObject")
          ]) : startswith("${var.pipeline_assets_bucket_arn}/${location}", trimsuffix(r, "*"))
      ])
    ])
    error_message = "every pipeline S3 prefix or key in the task environment must be covered by an s3:GetObject resource on the pipeline bucket"
  }

  # Verb per resource, as the BFF actually calls S3. PutObject reaches exactly the four locations the
  # BFF writes (emails/, deal-csv/, the parser prompt, the skills prefix) ...
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : flatten([s.Resource])
      if contains(s.Action, "s3:PutObject") && startswith(flatten([s.Resource])[0], var.pipeline_assets_bucket_arn)
      ])) == toset([
      "${var.pipeline_assets_bucket_arn}/emails/*",
      "${var.pipeline_assets_bucket_arn}/deal-csv/*",
      "${var.pipeline_assets_bucket_arn}/${var.pipeline_parser_prompt_key}",
      "${var.pipeline_assets_bucket_arn}/${var.pipeline_skills_prefix}*",
    ])
    error_message = "s3:PutObject on the pipeline bucket must cover exactly emails/, deal-csv/, the parser prompt key and the skills prefix"
  }

  # ... DeleteObject reaches the skills prefix alone (a retired skill is removed, not blanked) ...
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : flatten([s.Resource])
      if contains(s.Action, "s3:DeleteObject") && startswith(flatten([s.Resource])[0], var.pipeline_assets_bucket_arn)
    ])) == toset(["${var.pipeline_assets_bucket_arn}/${var.pipeline_skills_prefix}*"])
    error_message = "s3:DeleteObject on the pipeline bucket must cover the skills prefix and nothing else"
  }

  # ... and the Terraform-managed seeds the BFF only reads -- the sample corpus, the security master
  # the mock OMS validator trusts, the assistant prompt -- are reachable by no write verb at all.
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : [
        for r in flatten([s.Resource]) :
        strcontains(r, "/${var.pipeline_samples_prefix}") || strcontains(r, "/security-master/") || endswith(r, "/prompts/assistant-system.md")
      ] if contains(s.Action, "s3:PutObject") || contains(s.Action, "s3:DeleteObject")
    ]))
    error_message = "samples/, security-master/ and prompts/assistant-system.md are read-only for the console: no statement granting PutObject or DeleteObject may name them"
  }

  # ListBucket is confined to the two prefixes the BFF lists, and the pipeline bucket's ListBucket
  # statement is the only one on that bucket.
  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s.Condition.StringLike["s3:prefix"]
      if contains(s.Action, "s3:ListBucket") && flatten([s.Resource])[0] == var.pipeline_assets_bucket_arn
    ])) == toset(["${var.pipeline_skills_prefix}*", "${var.pipeline_samples_prefix}*"])
    error_message = "the pipeline ListBucket prefix condition must name exactly the skills and samples prefixes, the only two the BFF lists"
  }

  # Tables: all three and nothing else DynamoDB-shaped. No index ARN: the by_email GSI is the parser
  # Lambda's, and the BFF never queries it.
  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : flatten([s.Resource])
      if contains(flatten([s.Resource]), var.pipeline_emails_table_arn)
      ])) == toset([
      var.pipeline_emails_table_arn,
      var.pipeline_deals_table_arn,
      var.pipeline_skill_proposals_table_arn,
    ])
    error_message = "the pipeline DynamoDB statement must name the three tables and no index"
  }

  # Exactly the verbs src/lib/pipeline/server/aws.ts exports: getItem, putItem, scanAll.
  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s.Action
      if contains(flatten([s.Resource]), var.pipeline_emails_table_arn)
    ])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"])
    error_message = "the pipeline DynamoDB statement must grant GetItem, PutItem and Scan only: the BFF issues no UpdateItem, Query or DeleteItem"
  }

  # Both Lambdas the BFF invokes, and both memories with their record sub-resources.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      toset(flatten([s.Resource])) == toset([var.pipeline_parser_function_arn, var.pipeline_oms_upload_function_arn])
      if contains(s.Action, "lambda:InvokeFunction")
    ])
    error_message = "one lambda:InvokeFunction statement must name exactly the parser and the OMS upload function"
  }

  # Exactly the commands src/lib/pipeline/server/memoryClient.ts sends -- no DeleteEvent, which
  # nothing in the pipeline BFF calls.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      toset(flatten([s.Resource])) == toset([
        var.pipeline_knowledge_memory_arn, "${var.pipeline_knowledge_memory_arn}/*",
        var.pipeline_chat_memory_arn, "${var.pipeline_chat_memory_arn}/*",
        ]) && toset(s.Action) == toset([
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:ListMemoryRecords",
        "bedrock-agentcore:BatchDeleteMemoryRecords",
        "bedrock-agentcore:GetMemory",
      ])
      if contains(s.Action, "bedrock-agentcore:CreateEvent")
    ])
    error_message = "the pipeline memory statement must cover both memories (and their records) with exactly CreateEvent, ListEvents, RetrieveMemoryRecords, ListMemoryRecords, BatchDeleteMemoryRecords and GetMemory"
  }

  # The pipeline's model parameter is under /<name_prefix>-pipeline/, which the recon SSM statement's
  # /<name_prefix>/* does NOT match -- so its own statement must exist and name the exact ARN.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      flatten([s.Resource]) == [var.pipeline_agent_model_param_arn] && contains(s.Action, "ssm:PutParameter")
      if contains(s.Action, "ssm:GetParameter")
    ])
    error_message = "the pipeline model parameter needs its own Get/PutParameter statement on its exact ARN"
  }
}
