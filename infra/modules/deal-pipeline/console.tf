####################################################################################
# What the console's BFF needs from this module, exported for modules/frontend-ecs's app_wiring
# input (infra/environments/recon passes them as app_wiring.pipeline): the container environment
# the pipeline BFF reads (chatbot-app/frontend/src/lib/pipeline/server/env.ts) and the task-role
# statements that reach exactly these resources with exactly the verbs the BFF issues. The console
# module knows apps only in the abstract; the verb-per-resource knowledge lives here, beside the
# Lambda grants in lambdas.tf that keep the same invariant for the same bucket.
#
# Both lists were built inside modules/frontend-ecs from 22 pipeline_* inputs until they moved
# here. They moved UNCHANGED -- the same names and values, the same statements in the same order --
# and tests/console_wiring.tftest.hcl pins the rendering byte-for-byte against what that module
# produced, so a deployed console's task role reads the same either way.
####################################################################################

locals {
  # The S3 locations the BFF touches, named ONCE and grouped by the verbs the BFF actually issues
  # (src/lib/pipeline/server/{skillsStore,samples,emailStore,dealStore,chatAgent}.ts), so the object
  # grants, the ListBucket condition and the environment cannot disagree. oms-staging/ is
  # deliberately absent: only the mock OMS Lambda writes there, and nothing in the console reads it
  # back.
  #
  # Read only. samples/ and security-master/ are Terraform-managed seeds that track the repo, and
  # the assistant prompt has no UI editor; the BFF only ever GETs them. PutObject or DeleteObject
  # here would let a compromised task rewrite counterparties.csv -- the list the mock OMS validator
  # trusts and the one the parser role is deliberately denied write access to -- or delete the
  # sample corpus, and either would stand until the next apply re-uploaded the seed.
  console_s3_read_only = [
    "${local.samples_prefix}*",
    "${local.security_master_prefix}*",
    local.assistant_prompt_key,
  ]
  # Read and write, no delete. emails/<id>.json is the BFF's own copy of each received email;
  # deal-csv/<id>.csv is the staging CSV the BFF re-renders when a deal's fields are edited; the
  # parser prompt is the one prompt the Skills tab edits in place. Nothing removes any of them: a
  # rejected deal and a superseded email stay on the record.
  console_s3_read_write = [
    "${local.emails_prefix}*",
    "${local.deal_csv_prefix}*",
    local.parser_prompt_key,
  ]
  # Read, write AND delete: the Skills tab. A retired skill is removed, not blanked, or the parser
  # would still load an empty SKILL.md.
  console_s3_read_write_delete = [
    "${local.skills_prefix}*",
  ]
  # The only two prefixes the BFF LISTS: the Skills tab lists skills/, the simulate dialog lists
  # samples/. Everything else is addressed by exact key.
  console_s3_listed_prefixes = [
    "${local.skills_prefix}*",
    "${local.samples_prefix}*",
  ]

  # Container environment the pipeline BFF reads (env.ts).
  #
  # The three PIPELINE_-prefixed names collide with recon's ASSETS_BUCKET / AGENT_MODEL_PARAM /
  # SKILLS_PREFIX, which name recon's bucket, parameter and prefix in the same process; the pipeline
  # BFF reads ONLY the prefixed names (a bare-name fallback once resolved to recon's bucket and
  # parameter in this very task). The rest are unprefixed because nothing in recon reads them. The
  # order is the one the console rendered before the wiring moved here, and the console module
  # appends it UNCHANGED (it never re-sorts an app's variables), so a deployed console's task
  # definition -- and its revision -- reads the same either way. Reordering these entries IS a new
  # revision and a rolling deployment of the console; tests/console_wiring.tftest.hcl pins the order.
  console_environment = [
    { name = "PIPELINE_ASSETS_BUCKET", value = aws_s3_bucket.assets.bucket },
    { name = "PIPELINE_AGENT_MODEL_PARAM", value = aws_ssm_parameter.agent_model_id.name },
    { name = "PIPELINE_SKILLS_PREFIX", value = local.skills_prefix },
    { name = "EMAILS_TABLE", value = aws_dynamodb_table.emails.name },
    { name = "DEALS_TABLE", value = aws_dynamodb_table.deals.name },
    { name = "SKILL_PROPOSALS_TABLE", value = aws_dynamodb_table.skill_proposals.name },
    { name = "KNOWLEDGE_MEMORY_ID", value = module.knowledge_memory.memory_id },
    { name = "CHAT_MEMORY_ID", value = module.chat_memory.memory_id },
    { name = "PARSER_FUNCTION", value = aws_lambda_function.parser.function_name },
    { name = "OMS_UPLOAD_FUNCTION", value = aws_lambda_function.oms_upload.function_name },
    # The assistant has no Config-tab override, so it runs the model the parser is SEEDED with; the
    # parser itself follows the SSM parameter at runtime.
    { name = "ASSISTANT_MODEL_ID", value = var.agent_model_id },
    { name = "PARSER_PROMPT_KEY", value = local.parser_prompt_key },
    # The simulate dialog's corpus comes from S3 here. There is deliberately no SAMPLE_EMAILS_DIR: the
    # container has no checkout, and a disk path would read as configured while listing nothing.
    { name = "PIPELINE_SAMPLES_PREFIX", value = local.samples_prefix },
  ]

  # Task-role statements for the console container. The console module appends them after every
  # recon statement, in this order, and jsonencode()s the whole policy; nothing here is rendered on
  # its own.
  console_task_statements = [
    {
      # The three pipeline tables, with exactly the verbs src/lib/pipeline/server/aws.ts exports:
      # getItem, putItem (whole-row writes, conditional where a status transition needs it) and
      # scanAll. Scan because the inbox, the deal list and the proposals list are all rendered whole
      # -- demo-scale tables with no listing index. No UpdateItem, no Query and no index ARN: the BFF
      # issues neither (the by_email GSI is the parser Lambda's, for re-parse). No DeleteItem: rows
      # are superseded or rejected, never removed, so a proposal's decision and a deal's rejection
      # stay on the record.
      Effect = "Allow"
      Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"]
      Resource = [
        aws_dynamodb_table.emails.arn,
        aws_dynamodb_table.deals.arn,
        aws_dynamodb_table.skill_proposals.arn,
      ]
    },
    {
      # Object-level, one statement per access tier (the locals above), and nothing else in the
      # bucket. Note the parser Lambda's own role in lambdas.tf can read none of emails/ or
      # deal-csv/; this role can, because it is the one writing them.
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = [for p in local.console_s3_read_only : "${aws_s3_bucket.assets.arn}/${p}"]
    },
    {
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = [for p in local.console_s3_read_write : "${aws_s3_bucket.assets.arn}/${p}"]
    },
    {
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = [for p in local.console_s3_read_write_delete : "${aws_s3_bucket.assets.arn}/${p}"]
    },
    {
      # ListBucket authorizes on the BUCKET arn; the prefix condition confines it to the two prefixes
      # the BFF lists, the way the parser's ListBucket in lambdas.tf is scoped. Narrower than the
      # object grants on purpose: a listing is how a compromised task would discover keys it was
      # never told about.
      Effect    = "Allow"
      Action    = ["s3:ListBucket"]
      Resource  = aws_s3_bucket.assets.arn
      Condition = { StringLike = { "s3:prefix" = local.console_s3_listed_prefixes } }
    },
    {
      # Intake and reparse async-invoke the parser; approve invokes the mock OMS synchronously.
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.parser.arn, aws_lambda_function.oms_upload.arn]
    },
    {
      # The assistant chat calls Bedrock directly from the BFF (there is no agent runtime in the
      # pipeline; the parser is a Lambda). Same shape as the memory and parser roles: the model is
      # runtime-selectable, so the grant covers every foundation model and this account's inference
      # profiles rather than one fixed id.
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/*",
      ]
    },
    {
      # Both memories, with exactly the commands src/lib/pipeline/server/memoryClient.ts sends.
      # Knowledge: the assistant's save_memory tool writes an event (CreateEvent), the assistant
      # recalls consolidated records (RetrieveMemoryRecords), the Memory Manager lists and
      # batch-deletes them. Chat: the assistant appends each turn (CreateEvent) and rebuilds history
      # on page load (ListEvents). GetMemory is the read behind the Memory Manager's strategy panel,
      # the same as recon's. No DeleteEvent: nothing in the pipeline BFF deletes an event -- the recon
      # session routes that do target recon's MEMORY_ID under recon's own grant.
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:ListMemoryRecords",
        "bedrock-agentcore:BatchDeleteMemoryRecords",
        "bedrock-agentcore:GetMemory",
      ]
      Resource = [
        module.knowledge_memory.memory_arn,
        "${module.knowledge_memory.memory_arn}/*",
        module.chat_memory.memory_arn,
        "${module.chat_memory.memory_arn}/*",
      ]
    },
    {
      # The pipeline's Config tab reads and writes the parser model selection. Recon's own SSM grant
      # is path-scoped to /<recon prefix>/*, which this parameter is NOT under (it lives under this
      # module's prefix), so it is named here explicitly -- and enumerated rather than path-scoped,
      # because a wildcard over this prefix would hand the console every parameter added under it.
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:PutParameter"]
      Resource = aws_ssm_parameter.agent_model_id.arn
    },
  ]
}
