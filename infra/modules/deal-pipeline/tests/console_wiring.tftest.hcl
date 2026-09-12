# Run from this module's directory: `terraform init && terraform test`.
#
# The AWS provider is MOCKED (lambdas.tftest.hcl explains the well-formed defaults); nothing is
# created, no credentials are read. The ARN and id overrides below are what let the assertions tell
# resources apart and join an ARN to an environment value; the mock's default is a random string.
#
# Under test is what this module hands the console: the outputs console_environment and
# console_task_statements, which the recon root passes to modules/frontend-ecs as app_wiring.pipeline.
# Three things about them:
#   1. every grant is exactly what the BFF calls, verb per resource, and every resource named in the
#      environment is one the grants reach -- the invariant lambdas.tftest.hcl keeps for the Lambdas;
#   2. the environment is exactly the documented set of names, with the PIPELINE_ prefix where a
#      recon name would otherwise collide;
#   3. GOLDEN: both lists hash to what modules/frontend-ecs rendered from its 22 pipeline_* inputs
#      before the wiring moved here, for these same values -- so a deployed console's grants and
#      variables read the same, byte for byte, either way.

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/deal-pipeline-test-mock"
    }
  }
  override_data {
    target = data.aws_iam_policy_document.lambda_assume
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }
  override_data {
    target = data.aws_region.current
    values = {
      region = "us-east-1"
    }
  }
  override_resource {
    target = aws_s3_bucket.assets
    values = {
      arn = "arn:aws:s3:::deal-pipeline-test-assets-123456789012"
    }
  }
  override_resource {
    target = aws_dynamodb_table.emails
    values = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deal-pipeline-test-emails"
    }
  }
  override_resource {
    target = aws_dynamodb_table.deals
    values = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deal-pipeline-test-deals"
    }
  }
  override_resource {
    target = aws_dynamodb_table.skill_proposals
    values = {
      arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deal-pipeline-test-skill-proposals"
    }
  }
  override_resource {
    target = module.knowledge_memory.aws_bedrockagentcore_memory.this
    values = {
      id  = "deal_pipeline_test_knowledge-abc"
      arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/deal_pipeline_test_knowledge-abc"
    }
  }
  override_resource {
    target = module.chat_memory.aws_bedrockagentcore_memory.this
    values = {
      id  = "deal_pipeline_test_chat-def"
      arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/deal_pipeline_test_chat-def"
    }
  }
  override_resource {
    target = aws_lambda_function.parser
    values = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:deal-pipeline-test-parser"
    }
  }
  override_resource {
    target = aws_lambda_function.oms_upload
    values = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:deal-pipeline-test-oms-upload"
    }
  }
  override_resource {
    target = aws_ssm_parameter.agent_model_id
    values = {
      arn = "arn:aws:ssm:us-east-1:123456789012:parameter/deal-pipeline-test/agent-model-id"
    }
  }
}

variables {
  name_prefix        = "deal-pipeline-test"
  lambda_zip         = "never-read-under-a-mock-provider.zip"
  lambda_source_hash = "dGVzdA=="

  # The environment names the console hands the pipeline BFF, in the order this module exports them
  # -- the order modules/frontend-ecs rendered before the wiring moved here, and the order that module
  # still appends them in (it never re-sorts), so a deployed task definition is unchanged by the move.
  # Test-only, written once for the runs below.
  console_env_names = [
    "PIPELINE_ASSETS_BUCKET", "PIPELINE_AGENT_MODEL_PARAM", "PIPELINE_SKILLS_PREFIX",
    "EMAILS_TABLE", "DEALS_TABLE", "SKILL_PROPOSALS_TABLE",
    "KNOWLEDGE_MEMORY_ID", "CHAT_MEMORY_ID",
    "PARSER_FUNCTION", "OMS_UPLOAD_FUNCTION",
    "ASSISTANT_MODEL_ID", "PARSER_PROMPT_KEY", "PIPELINE_SAMPLES_PREFIX",
  ]

  # GOLDEN. sha256 of jsonencode() of the statement list and of the environment list that
  # modules/frontend-ecs built from its pipeline_* inputs (locals pipeline_task_statements and
  # pipeline_task_environment, before app_wiring) when given exactly the ARNs, names and prefixes the
  # overrides above and this module's naming produce. The two runs at the end require this module's
  # exports to hash to them, which is what "the statements moved, they did not change" means. If a
  # grant or a variable is changed ON PURPOSE, regenerate from a plan of this module:
  #   sha256(jsonencode([for s in output.console_task_statements : jsondecode(s)]))
  #   sha256(jsonencode(output.console_environment))
  golden_statements_sha256  = "0420c9ae7568873d7b7f3eae553ca8e6ef28b206111d1d027921e15f11820992"
  golden_environment_sha256 = "b4944f5d63d3d84d7f230e6218441df75eba661cbb3f75545e84128cb46eac00"
}

run "console_environment_is_exactly_the_documented_set_with_this_modules_values" {
  # Every documented BFF variable, each once, in the export order.
  assert {
    condition     = [for e in output.console_environment : e.name] == var.console_env_names
    error_message = "console_environment must carry exactly the documented BFF variables, once each, in the documented order"
  }

  # The prefixed names carry THIS module's bucket, parameter and prefix -- the collision with recon's
  # ASSETS_BUCKET / AGENT_MODEL_PARAM / SKILLS_PREFIX is the reason the prefix exists.
  assert {
    condition = (
      { for e in output.console_environment : e.name => e.value }["PIPELINE_ASSETS_BUCKET"] == aws_s3_bucket.assets.bucket
      && { for e in output.console_environment : e.name => e.value }["PIPELINE_AGENT_MODEL_PARAM"] == aws_ssm_parameter.agent_model_id.name
      && { for e in output.console_environment : e.name => e.value }["PIPELINE_SKILLS_PREFIX"] == output.skills_prefix
      && { for e in output.console_environment : e.name => e.value }["PIPELINE_SAMPLES_PREFIX"] == output.samples_prefix
      && { for e in output.console_environment : e.name => e.value }["PARSER_PROMPT_KEY"] == output.parser_prompt_key
    )
    error_message = "the PIPELINE_-prefixed variables and PARSER_PROMPT_KEY must carry this module's bucket, parameter name and S3 layout"
  }

  # Every table, memory and function the environment names is the one THIS module creates -- the
  # grants below name the same resources' ARNs, so the two sides cannot drift apart.
  assert {
    condition = (
      { for e in output.console_environment : e.name => e.value }["EMAILS_TABLE"] == aws_dynamodb_table.emails.name
      && { for e in output.console_environment : e.name => e.value }["DEALS_TABLE"] == aws_dynamodb_table.deals.name
      && { for e in output.console_environment : e.name => e.value }["SKILL_PROPOSALS_TABLE"] == aws_dynamodb_table.skill_proposals.name
      && { for e in output.console_environment : e.name => e.value }["KNOWLEDGE_MEMORY_ID"] == output.knowledge_memory_id
      && { for e in output.console_environment : e.name => e.value }["CHAT_MEMORY_ID"] == output.chat_memory_id
      && { for e in output.console_environment : e.name => e.value }["PARSER_FUNCTION"] == aws_lambda_function.parser.function_name
      && { for e in output.console_environment : e.name => e.value }["OMS_UPLOAD_FUNCTION"] == aws_lambda_function.oms_upload.function_name
    )
    error_message = "every table, memory and function in console_environment must be the one this module creates"
  }

  # The assistant runs the model the parser is seeded with; there is no Config-tab override for it.
  assert {
    condition     = { for e in output.console_environment : e.name => e.value }["ASSISTANT_MODEL_ID"] == var.agent_model_id
    error_message = "ASSISTANT_MODEL_ID must be agent_model_id: the assistant has no runtime model override"
  }

  # No SAMPLE_EMAILS_DIR in a container: a disk path reads as configured and lists nothing.
  assert {
    condition     = !contains([for e in output.console_environment : e.name], "SAMPLE_EMAILS_DIR")
    error_message = "SAMPLE_EMAILS_DIR must never be exported to the console task; the container reads the corpus from S3"
  }
}

run "console_grants_are_exactly_what_the_bff_calls" {
  # Every statement is a JSON document with the shape IAM expects: Effect, Action, Resource.
  assert {
    condition = alltrue([
      for s in output.console_task_statements : can(jsondecode(s).Effect) && can(jsondecode(s).Action) && can(jsondecode(s).Resource)
    ])
    error_message = "every console_task_statements entry must be a jsonencode()d IAM statement with Effect, Action and Resource"
  }

  # Every S3 location the environment names is one the role can read: the skills prefix, the samples
  # prefix and the parser prompt key each fall under a GetObject resource on THIS bucket.
  assert {
    condition = alltrue([
      for location in [
        { for e in output.console_environment : e.name => e.value }["PIPELINE_SKILLS_PREFIX"],
        { for e in output.console_environment : e.name => e.value }["PIPELINE_SAMPLES_PREFIX"],
        { for e in output.console_environment : e.name => e.value }["PARSER_PROMPT_KEY"],
        ] : anytrue([
          for r in flatten([
            for s in output.console_task_statements : jsondecode(s).Resource
            if contains(jsondecode(s).Action, "s3:GetObject")
          ]) : startswith("${aws_s3_bucket.assets.arn}/${location}", trimsuffix(r, "*"))
      ])
    ])
    error_message = "every S3 prefix or key in console_environment must be covered by an s3:GetObject resource on the pipeline bucket"
  }

  # Verb per resource, as the BFF actually calls S3. PutObject reaches exactly the four locations the
  # BFF writes (emails/, deal-csv/, the parser prompt, the skills prefix) ...
  assert {
    condition = toset(flatten([
      for s in output.console_task_statements : flatten([jsondecode(s).Resource])
      if contains(jsondecode(s).Action, "s3:PutObject")
      ])) == toset([
      "${aws_s3_bucket.assets.arn}/emails/*",
      "${aws_s3_bucket.assets.arn}/deal-csv/*",
      "${aws_s3_bucket.assets.arn}/${output.parser_prompt_key}",
      "${aws_s3_bucket.assets.arn}/${output.skills_prefix}*",
    ])
    error_message = "s3:PutObject must cover exactly emails/, deal-csv/, the parser prompt key and the skills prefix"
  }

  # ... DeleteObject reaches the skills prefix alone (a retired skill is removed, not blanked) ...
  assert {
    condition = toset(flatten([
      for s in output.console_task_statements : flatten([jsondecode(s).Resource])
      if contains(jsondecode(s).Action, "s3:DeleteObject")
    ])) == toset(["${aws_s3_bucket.assets.arn}/${output.skills_prefix}*"])
    error_message = "s3:DeleteObject must cover the skills prefix and nothing else"
  }

  # ... and the Terraform-managed seeds the BFF only reads -- the sample corpus, the security master
  # the mock OMS validator trusts, the assistant prompt -- are reachable by no write verb at all, and
  # oms-staging/ (the mock OMS Lambda's output) by no verb whatsoever.
  assert {
    condition = !anytrue(flatten([
      for s in output.console_task_statements : [
        for r in flatten([jsondecode(s).Resource]) :
        strcontains(r, "/${output.samples_prefix}") || strcontains(r, "/security-master/") || endswith(r, "/prompts/assistant-system.md")
      ] if contains(jsondecode(s).Action, "s3:PutObject") || contains(jsondecode(s).Action, "s3:DeleteObject")
    ]))
    error_message = "samples/, security-master/ and prompts/assistant-system.md are read-only for the console: no statement granting PutObject or DeleteObject may name them"
  }

  assert {
    condition = !anytrue(flatten([
      for s in output.console_task_statements : concat(
        [for r in flatten([jsondecode(s).Resource]) : strcontains(r, "oms-staging/")],
        [for p in try(jsondecode(s).Condition.StringLike["s3:prefix"], []) : startswith(p, "oms-staging/")],
      )
    ]))
    error_message = "no console grant may name oms-staging/: only the mock OMS Lambda writes there and nothing in the console reads it back"
  }

  # ListBucket authorizes on the bucket ARN and is confined to the two prefixes the BFF lists; it is
  # the only ListBucket statement.
  assert {
    condition = toset(one([
      for s in output.console_task_statements : jsondecode(s).Condition.StringLike["s3:prefix"]
      if contains(jsondecode(s).Action, "s3:ListBucket")
    ])) == toset(["${output.skills_prefix}*", "${output.samples_prefix}*"])
    error_message = "the one ListBucket statement's prefix condition must name exactly the skills and samples prefixes, the only two the BFF lists"
  }

  assert {
    condition = one([
      for s in output.console_task_statements : jsondecode(s).Resource
      if contains(jsondecode(s).Action, "s3:ListBucket")
    ]) == aws_s3_bucket.assets.arn
    error_message = "ListBucket must be granted on the bucket ARN itself, not on an object path"
  }

  # Tables: all three and nothing else DynamoDB-shaped. No index ARN: the by_email GSI is the parser
  # Lambda's, and the BFF never queries it.
  assert {
    condition = toset(one([
      for s in output.console_task_statements : flatten([jsondecode(s).Resource])
      if contains(flatten([jsondecode(s).Resource]), aws_dynamodb_table.emails.arn)
      ])) == toset([
      aws_dynamodb_table.emails.arn,
      aws_dynamodb_table.deals.arn,
      aws_dynamodb_table.skill_proposals.arn,
    ])
    error_message = "the DynamoDB statement must name the three tables and no index"
  }

  # Exactly the verbs src/lib/pipeline/server/aws.ts exports: getItem, putItem, scanAll.
  assert {
    condition = toset(one([
      for s in output.console_task_statements : jsondecode(s).Action
      if contains(flatten([jsondecode(s).Resource]), aws_dynamodb_table.emails.arn)
    ])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"])
    error_message = "the DynamoDB statement must grant GetItem, PutItem and Scan only: the BFF issues no UpdateItem, Query or DeleteItem"
  }

  # Both Lambdas the BFF invokes -- the same two the environment names -- and nothing else.
  assert {
    condition = one([
      for s in output.console_task_statements : toset(flatten([jsondecode(s).Resource]))
      if contains(jsondecode(s).Action, "lambda:InvokeFunction")
    ]) == toset([aws_lambda_function.parser.arn, aws_lambda_function.oms_upload.arn])
    error_message = "one lambda:InvokeFunction statement must name exactly the parser and the OMS upload function"
  }

  # Both memories with their record sub-resources, and exactly the commands
  # src/lib/pipeline/server/memoryClient.ts sends -- no DeleteEvent, which nothing in the BFF calls.
  assert {
    condition = anytrue([
      for s in output.console_task_statements :
      toset(flatten([jsondecode(s).Resource])) == toset([
        output.knowledge_memory_arn, "${output.knowledge_memory_arn}/*",
        output.chat_memory_arn, "${output.chat_memory_arn}/*",
        ]) && toset(jsondecode(s).Action) == toset([
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:ListMemoryRecords",
        "bedrock-agentcore:BatchDeleteMemoryRecords",
        "bedrock-agentcore:GetMemory",
      ])
      if contains(jsondecode(s).Action, "bedrock-agentcore:CreateEvent")
    ])
    error_message = "the memory statement must cover both memories (and their records) with exactly CreateEvent, ListEvents, RetrieveMemoryRecords, ListMemoryRecords, BatchDeleteMemoryRecords and GetMemory"
  }

  # The assistant calls Bedrock from the BFF: every foundation model plus this account's inference
  # profiles, the same shape as the parser and memory roles.
  assert {
    condition = anytrue([
      for s in output.console_task_statements :
      toset(flatten([jsondecode(s).Resource])) == toset(["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*"])
      if contains(jsondecode(s).Action, "bedrock:InvokeModel")
    ])
    error_message = "the Bedrock statement must cover every foundation model and this account's inference profiles"
  }

  # The model parameter is under /<name_prefix>/, which recon's path-scoped SSM grant does not match,
  # so its own Get/Put statement names the exact ARN -- and it is the parameter the environment names.
  assert {
    condition = anytrue([
      for s in output.console_task_statements :
      jsondecode(s).Resource == aws_ssm_parameter.agent_model_id.arn && toset(jsondecode(s).Action) == toset(["ssm:GetParameter", "ssm:PutParameter"])
      if contains(jsondecode(s).Action, "ssm:GetParameter")
    ])
    error_message = "the model parameter needs its own GetParameter/PutParameter statement on its exact ARN"
  }
}

# The byte-for-byte proof that the wiring MOVED from modules/frontend-ecs without changing: the
# statement list and the environment list re-encode to exactly what that module rendered from its
# pipeline_* inputs for these values.
run "console_wiring_is_byte_for_byte_what_the_console_module_rendered" {
  assert {
    condition     = sha256(jsonencode([for s in output.console_task_statements : jsondecode(s)])) == var.golden_statements_sha256
    error_message = "console_task_statements no longer re-encode to the statements modules/frontend-ecs rendered before the move; a grant changed"
  }

  assert {
    condition     = sha256(jsonencode(output.console_environment)) == var.golden_environment_sha256
    error_message = "console_environment no longer matches the environment modules/frontend-ecs rendered before the move; a name, value or position changed"
  }
}
