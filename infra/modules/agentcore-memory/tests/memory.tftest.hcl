# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under a MOCKED AWS provider: nothing is created, no credentials are read. The mock still
# needs the provider binary for its schema, hence the init. override_during = plan makes the mocked
# role ARN known at plan so the memory's and strategy's memory_execution_role_arn can be asserted
# against it; the provider's own schema validation still runs, and its ARN check on that argument is
# why the mock role carries a well-formed ARN rather than the mock's default random string.
#
# Under test is the contract both consumers rely on when they move an existing memory in here:
#   1. the strategy exists if and only if one is configured, and carries exactly the caller's values
#      (name, namespaces, description, model, prompt) under CUSTOM / SEMANTIC_OVERRIDE / extraction;
#   2. the execution role's policy grants InvokeModel and InvokeModelWithResponseStream on every
#      foundation model and on this account's inference profiles -- and renders BYTE FOR BYTE the JSON
#      the recon module rendered inline before the move, so the moved policy plans no update;
#   3. the role is declared on the memory itself as well as on the strategy (the permanent-drift
#      lesson), and a memory sharing another memory's role creates none of its own.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/memory-test-memory"
    }
  }
  # Known at plan so the strategy's memory_id can be asserted against it (a type with no mock_resource
  # block has its computed values generated at apply, override_during notwithstanding).
  mock_resource "aws_bedrockagentcore_memory" {
    defaults = {
      id  = "memory_test_memory-abc"
      arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/memory_test_memory-abc"
    }
  }
}

variables {
  name                = "memory_test_memory"
  event_expiry_days   = 30
  region              = "us-east-1"
  account_id          = "123456789012"
  execution_role_name = "memory-test-memory"

  lessons = {
    name              = "lessons_learned"
    namespaces        = ["reconciliation/lessons/{actorId}"]
    description       = "Generalizable lessons derived from analyst decisions."
    model_id          = "us.anthropic.claude-sonnet-5"
    extraction_prompt = "You are a long-term memory extraction agent.\n\n# What counts as a lesson\nA reusable rule.\n"
  }
}

run "a_configured_strategy_is_created_with_exactly_the_callers_values" {
  command = plan

  variables {
    strategy = var.lessons
  }

  assert {
    condition     = length(aws_bedrockagentcore_memory_strategy.this) == 1
    error_message = "a configured strategy must create exactly one aws_bedrockagentcore_memory_strategy"
  }

  assert {
    condition = (
      aws_bedrockagentcore_memory_strategy.this[0].name == "lessons_learned"
      && aws_bedrockagentcore_memory_strategy.this[0].type == "CUSTOM"
      && aws_bedrockagentcore_memory_strategy.this[0].description == "Generalizable lessons derived from analyst decisions."
    )
    error_message = "the strategy must be CUSTOM and carry the caller's name and description unchanged"
  }

  # Its own assertion, on purpose: `namespaces` is provider-deprecated and the value carries a
  # deprecation mark, which Terraform 1.16's diagnostic renderer cannot serialise -- a failing
  # assertion that references it crashes the run instead of reporting. Kept apart so any other
  # failure in this run still reports normally. (A set on the resource, hence toset.)
  assert {
    condition     = toset(aws_bedrockagentcore_memory_strategy.this[0].namespaces) == toset(["reconciliation/lessons/{actorId}"])
    error_message = "the strategy must carry the caller's namespaces unchanged"
  }

  # The override is of EXTRACTION only, and the prompt travels verbatim: a trailing newline lost or
  # added here is exactly the no-op-looking in-place update the plan checklist forbids.
  assert {
    condition = (
      aws_bedrockagentcore_memory_strategy.this[0].configuration[0].type == "SEMANTIC_OVERRIDE"
      && length(aws_bedrockagentcore_memory_strategy.this[0].configuration[0].extraction) == 1
      && length(aws_bedrockagentcore_memory_strategy.this[0].configuration[0].consolidation) == 0
      && aws_bedrockagentcore_memory_strategy.this[0].configuration[0].extraction[0].model_id == "us.anthropic.claude-sonnet-5"
      && aws_bedrockagentcore_memory_strategy.this[0].configuration[0].extraction[0].append_to_prompt == var.lessons.extraction_prompt
    )
    error_message = "the configuration must be SEMANTIC_OVERRIDE with an extraction block only, carrying the caller's model id and the extraction prompt byte for byte"
  }

  assert {
    condition     = aws_bedrockagentcore_memory_strategy.this[0].memory_id == aws_bedrockagentcore_memory.this.id
    error_message = "the strategy must attach to the memory created here"
  }

  # The drift lesson: the role is on the parent memory AND on the strategy, and it is the role
  # created here.
  assert {
    condition = (
      aws_bedrockagentcore_memory.this.memory_execution_role_arn == aws_iam_role.memory[0].arn
      && aws_bedrockagentcore_memory_strategy.this[0].memory_execution_role_arn == aws_iam_role.memory[0].arn
      && output.execution_role_arn == aws_iam_role.memory[0].arn
    )
    error_message = "memory_execution_role_arn must be declared on the memory and on the strategy, and both must be the role created here"
  }

  assert {
    condition = (
      aws_bedrockagentcore_memory.this.name == "memory_test_memory"
      && aws_bedrockagentcore_memory.this.event_expiry_duration == 30
      && aws_bedrockagentcore_memory.this.description == null
      && aws_bedrockagentcore_memory.this.tags == null
    )
    error_message = "the memory must carry the caller's name and expiry, and leave description and tags UNSET when none are given (an existing memory moved in here must plan no update)"
  }

  assert {
    condition     = aws_iam_role.memory[0].name == "memory-test-memory" && aws_iam_role_policy.memory[0].name == "memory-test-memory-policy"
    error_message = "the role is named exactly execution_role_name and its policy \"<role>-policy\", the convention every existing memory follows"
  }
}

run "the_execution_role_may_invoke_every_foundation_model_and_this_accounts_inference_profiles" {
  command = plan

  variables {
    strategy = var.lessons
  }

  assert {
    condition = toset(jsondecode(aws_iam_role_policy.memory[0].policy).Statement[0].Action) == toset([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ])
    error_message = "the policy's one statement must grant exactly bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream"
  }

  assert {
    condition = toset(jsondecode(aws_iam_role_policy.memory[0].policy).Statement[0].Resource) == toset([
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*",
    ])
    error_message = "the grant must name every foundation model (any region) and the caller's own region/account inference profiles, so the extraction model can be re-pointed without an IAM change"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.memory[0].policy).Statement) == 1
    error_message = "the execution role holds one statement: model invocation and nothing else"
  }

  # GOLDEN, byte for byte. This is the jsonencode() modules/recon-agent evaluated inline for its
  # memory role before the move (Version, then one Allow statement with these two actions and these
  # two resources, in this order). The moved aws_iam_role_policy plans an in-place update if the
  # rendered string differs by a character, so the string itself is pinned, not just its contents.
  assert {
    condition = aws_iam_role_policy.memory[0].policy == jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*",
        ]
      }]
    })
    error_message = "the policy JSON must be exactly what the consumers rendered inline before the move, or the moved aws_iam_role_policy plans an update"
  }

  assert {
    condition = aws_iam_role.memory[0].assume_role_policy == jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Principal = { Service = "bedrock-agentcore.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }]
    })
    error_message = "the trust policy must be exactly the bedrock-agentcore.amazonaws.com AssumeRole statement the consumers rendered inline"
  }
}

run "no_strategy_means_an_events_only_memory_with_no_strategy_resource" {
  command = plan

  assert {
    condition     = length(aws_bedrockagentcore_memory_strategy.this) == 0
    error_message = "with strategy = null no aws_bedrockagentcore_memory_strategy may be planned"
  }

  assert {
    condition     = output.strategy_id == null
    error_message = "strategy_id must be null when there is no strategy"
  }

  # The role is still required by the resource, and still created here.
  assert {
    condition     = aws_bedrockagentcore_memory.this.memory_execution_role_arn == aws_iam_role.memory[0].arn && length(aws_iam_role_policy.memory) == 1
    error_message = "an events-only memory still carries the execution role the resource requires"
  }
}

run "a_shared_role_is_attached_and_none_is_created" {
  command = plan

  variables {
    name                  = "memory_test_chat"
    event_expiry_days     = 7
    create_execution_role = false
    execution_role_name   = null
    execution_role_arn    = "arn:aws:iam::123456789012:role/memory-test-shared"
  }

  assert {
    condition     = length(aws_iam_role.memory) == 0 && length(aws_iam_role_policy.memory) == 0
    error_message = "with create_execution_role = false the module must create neither a role nor a policy"
  }

  assert {
    condition = (
      aws_bedrockagentcore_memory.this.memory_execution_role_arn == "arn:aws:iam::123456789012:role/memory-test-shared"
      && output.execution_role_arn == "arn:aws:iam::123456789012:role/memory-test-shared"
      && aws_bedrockagentcore_memory.this.event_expiry_duration == 7
    )
    error_message = "the memory must carry the role it was handed, and echo it back through execution_role_arn"
  }
}

run "description_and_tags_are_passed_through_when_given" {
  command = plan

  variables {
    description = "Assistant chat transcripts, raw events only."
    tags        = { Project = "memory-test" }
  }

  assert {
    condition     = aws_bedrockagentcore_memory.this.description == "Assistant chat transcripts, raw events only." && aws_bedrockagentcore_memory.this.tags == tomap({ Project = "memory-test" })
    error_message = "description and tags must reach the memory unchanged"
  }
}

run "an_expiry_outside_the_service_range_fails_at_plan" {
  command = plan

  variables {
    event_expiry_days = 3
  }

  expect_failures = [var.event_expiry_days]
}

run "a_created_role_without_a_name_fails_at_plan" {
  command = plan

  variables {
    execution_role_name = null
  }

  expect_failures = [var.execution_role_name]
}

run "a_shared_role_without_an_arn_fails_at_plan" {
  command = plan

  variables {
    create_execution_role = false
    execution_role_arn    = null
  }

  expect_failures = [var.execution_role_arn]
}
