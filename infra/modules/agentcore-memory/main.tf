####################################################################################
# agentcore-memory: one AgentCore Memory, the execution role it runs extraction under, and an
# optional CUSTOM / SEMANTIC_OVERRIDE extraction strategy.
#
# Two apps hold a memory built exactly this way -- recon's lessons memory (modules/recon-agent) and
# the deal pipeline's knowledge memory (modules/deal-pipeline), plus the pipeline's events-only chat
# memory -- and the two lessons this shape encodes were each learned once and must not be relearned
# per app: the execution role has to be declared on the PARENT memory as well as the strategy, and
# `append_to_prompt` replaces rather than appends. Both are spelled out at the resources below.
#
# Every argument is a plain pass-through so an existing memory moved into this module with a
# `moved` block plans no change: no defaults are applied to anything that was previously unset
# (description, tags), and the policy renders the same JSON the consumers rendered inline.
####################################################################################

locals {
  # The role every resource here references: created below, or handed in by the caller for a
  # memory that shares another memory's role (the pipeline's chat memory has no strategy and never
  # invokes a model, but the argument is required on the resource).
  execution_role_arn = var.create_execution_role ? aws_iam_role.memory[0].arn : var.execution_role_arn
}

# Execution role AgentCore Memory assumes to run the extraction/consolidation LLM passes for the
# strategy below.
resource "aws_iam_role" "memory" {
  count = var.create_execution_role ? 1 : 0

  name = var.execution_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "memory" {
  count = var.create_execution_role ? 1 : 0

  name = "${var.execution_role_name}-policy"
  role = aws_iam_role.memory[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # bedrock:InvokeModel targets runtime-selectable foundation models / cross-region inference
      # profiles; scoped to every foundation model and this account's inference-profile ARNs (not
      # fixed model ids) so model_id can be re-pointed -- including at a cross-region "us." profile,
      # which resolves to foundation models in OTHER regions -- without touching IAM.
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:${var.region}:${var.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_bedrockagentcore_memory" "this" {
  name                  = var.name
  description           = var.description
  event_expiry_duration = var.event_expiry_days
  # AWS stores the strategy's execution role on the parent Memory resource too -- must be
  # declared here as well, or every plan wants to null it back out (permanent drift). Required by
  # the resource even with no strategy attached.
  memory_execution_role_arn = local.execution_role_arn
  tags                      = var.tags

  # The provenance keys must be indexed on the memory before the strategy may pass them through.
  # Indexed keys are permanent once declared; see var.provenance_keys.
  dynamic "indexed_key" {
    for_each = toset(var.provenance_keys)
    content {
      key  = indexed_key.value
      type = "STRING"
    }
  }
}

# The extraction strategy, when the caller has one. CUSTOM rather than a built-in type (SEMANTIC and
# friends) because the built-in extraction prompt is written for a general-purpose personal
# assistant -- "extract meaningful information about the users" -- and, fed a domain decision,
# produces records ABOUT the user having said something: audit-trail entries the app's own ledger
# already holds, which generalize to nothing and displace the records that would inform a future
# item. Each consumer states its own domain version of that finding beside its prompt.
#
# Only EXTRACTION is overridden. Consolidation's Add/Update/Skip behaviour is already what every
# consumer wants, and AWS is explicit that editing that prompt (e.g. renaming AddMemory) breaks the
# pipeline. When extraction returns an empty list, nothing reaches consolidation, so this is
# sufficient.
#
# `namespaces` and the strategy-level `memory_execution_role_arn` are deprecated by the provider in
# favour of `namespace_templates` and the parent's role, but both existing memories were created with
# them and the provider still accepts them. They stay, deliberately: swapping either on a live
# strategy is an in-place update the plan checklist in infra/README.md says must not appear.
resource "aws_bedrockagentcore_memory_strategy" "this" {
  count = var.strategy == null ? 0 : 1

  memory_id                 = aws_bedrockagentcore_memory.this.id
  name                      = var.strategy.name
  type                      = "CUSTOM"
  namespaces                = var.strategy.namespaces
  memory_execution_role_arn = local.execution_role_arn
  description               = var.strategy.description

  configuration {
    type = "SEMANTIC_OVERRIDE"

    extraction {
      model_id = var.strategy.model_id
      # NOTE: `append_to_prompt` REPLACES the default instructions despite its name (AWS: "The
      # content of appendToPrompt replaces the default instructions in the system prompt"). The
      # caller's extraction_prompt is therefore a complete instruction set, built on the documented
      # built-in semantic extraction prompt. The service appends the output schema itself -- do not
      # restate or alter it, and keep the `language` field requirement the schema demands.
      append_to_prompt = var.strategy.extraction_prompt
    }
  }

  # Copies each provenance key from the source event onto the extracted record unchanged
  # (STRICTLY_CONSISTENT: passed through, never inferred by the model). Verified on a throwaway
  # memory: every extracted record carries exactly the keys of the one event it came from, and
  # consolidation added contradicting rules as new records rather than merging them, so a record's
  # provenance names a single source.
  dynamic "memory_record_schema" {
    for_each = length(var.provenance_keys) > 0 ? [1] : []
    content {
      dynamic "metadata_schema" {
        for_each = var.provenance_keys
        content {
          key             = metadata_schema.value
          type            = "STRING"
          extraction_type = "STRICTLY_CONSISTENT"
        }
      }
    }
  }
}
