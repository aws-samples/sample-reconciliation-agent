####################################################################################
# AgentCore Memory (design §8): two memories, one execution role.
#
#   <prefix>_knowledge  edge_cases strategy -- consolidated deal-parsing rules the desk saves
#                       from the assistant or the Memory Manager; recalled by the parser.
#   <prefix>_chat       events only, 7-day expiry -- the assistant's transcript so a chat
#                       session survives a page reload. No strategy: nothing to extract.
####################################################################################

# Execution role AgentCore Memory assumes to run the extraction/consolidation LLM passes for the
# edge_cases strategy. The chat memory has no strategy and never invokes a model, but the
# argument is required on the resource, so both memories carry the same role.
resource "aws_iam_role" "memory" {
  name = "${var.name_prefix}-memory"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "memory" {
  name = "${var.name_prefix}-memory-policy"
  role = aws_iam_role.memory.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # Every foundation model plus this account's inference profiles rather than one fixed model
      # id, so memory_model_id can be re-pointed (including at a cross-region "us." profile, which
      # resolves to foundation models in OTHER regions) without touching IAM.
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/*",
      ]
    }]
  })
}

resource "aws_bedrockagentcore_memory" "knowledge" {
  name                  = "${local.memory_name_base}_knowledge"
  description           = "Reusable deal-parsing rules the desk has taught the pipeline (edge cases, not universal skill rules)."
  event_expiry_duration = 30 # days
  # AWS stores the strategy's execution role on the parent Memory resource too -- must be
  # declared here as well, or every plan wants to null it back out (permanent drift).
  memory_execution_role_arn = aws_iam_role.memory.arn
}

resource "aws_bedrockagentcore_memory" "chat" {
  name                  = "${local.memory_name_base}_chat"
  description           = "Assistant chat transcripts, raw events only; rebuilt into history on page load."
  event_expiry_duration = 7 # days
  # Required by the resource even with no strategy attached.
  memory_execution_role_arn = aws_iam_role.memory.arn
}

# Edge-case strategy. The assistant's save_memory tool and the Memory Manager's manual add write
# one USER message per rule (rule + rationale) under deal-pipeline/edge-cases/deal-desk; the
# parser retrieves the consolidated records before its first model call and injects them as
# advisory context.
#
# CUSTOM rather than the built-in SEMANTIC type because the
# built-in extraction prompt is written for a general-purpose personal assistant ("extract
# meaningful information about the users"). Fed "when UOP is Project Finance, Secured Level is
# First Lien" it produces a record ABOUT the user having said so, and fed a deal discussion it
# records the deal's issue size -- facts the deals table already holds and that inform no future
# email.
#
# Only EXTRACTION is overridden. Consolidation's Add/Update/Skip behaviour is already what we want,
# and AWS is explicit that editing that prompt breaks the pipeline. When extraction returns an empty
# list, nothing reaches consolidation, so this is sufficient.
resource "aws_bedrockagentcore_memory_strategy" "edge_cases" {
  memory_id                 = aws_bedrockagentcore_memory.knowledge.id
  name                      = "edge_cases"
  type                      = "CUSTOM"
  namespaces                = ["deal-pipeline/edge-cases/{actorId}"]
  memory_execution_role_arn = aws_iam_role.memory.arn
  description               = "Conditional deal-parsing rules (trigger -> OMS field -> value) saved by the desk."

  configuration {
    type = "SEMANTIC_OVERRIDE"

    extraction {
      model_id = var.memory_model_id
      # NOTE: `append_to_prompt` REPLACES the default instructions despite its name (AWS: "The
      # content of appendToPrompt replaces the default instructions in the system prompt"). This is
      # therefore a complete instruction set, built on the documented built-in semantic extraction
      # prompt. The service appends the output schema itself -- do not restate or alter it, and keep
      # the `language` field requirement the schema demands.
      append_to_prompt = <<-EOT
        You are a long-term memory extraction agent supporting a new-issue deal desk. Your task is
        to identify and extract REUSABLE DEAL-PARSING RULES from a list of messages about how deal
        emails (bank launch notices, market news alerts, forwarded notices) are mapped to the fields
        of the desk's order management system (the OMS).

        The messages are usually rules the desk chose to save: a single user turn stating a rule
        and, often, the rationale behind it (for example an OMS upload rejection it fixes). Treat
        such a message as authoritative and extract the rule it states. Messages may also contain
        discussion of a particular deal; extract from those only what generalizes.

        # What counts as a rule
        A rule is a conditional mapping that would change how a FUTURE, DIFFERENT deal email is
        mapped to an OMS field. It has three parts:
          1. a trigger -- a deal attribute, instrument type, use of proceeds, rating, source
             format, counterparty, or wording in the email;
          2. the OMS field it affects, named by its label;
          3. the value, format, or derivation that field should take when the trigger holds.
        It must still make sense without naming the deal it came from.

        For example: "When UOP is Project Finance, Secured Level is First Lien even if the notice
        only says senior secured." Or: "When the Opportunity Name contains add-on or incremental,
        New Money (MM) is required and equals Issue Size (MM)."

        Extract a rule only when the messages state, or clearly imply, both the trigger and the
        resulting field value -- a desk correction, an upload rejection the user explains, a stated
        OMS convention, or an explicit instruction such as "remember that ...". A rule the desk
        states without a trigger is still a rule; write it as applying to every deal of the
        Pipeline Type it concerns.

        # What must NOT be extracted
        - Conversational chatter: greetings, questions, acknowledgements, requests for help.
        - One-off values for a single deal: an issue size, a spread, an OID, a date, a rating, a
          counterparty. "The add-on is 500 million" describes one deal, and the deal record
          already holds it. Return an empty list for such messages.
        - Deal identifiers, email ids, proposal ids, session ids, or the date a correction was
          made, as facts in their own right.
        - A restatement of how one deal was parsed that only substitutes the issuer name for a
          pronoun.
        - Anything you would have to name a specific deal to make true.

        # How to write a rule
        - Write it as one standalone conditional sentence: the trigger, then the OMS field, then
          the value. Name the OMS field by its label exactly as the desk wrote it (for example
          Secured Level, UOP, Covenant Status #, Left Agent, New Money (MM), Is Investment Grade?).
        - Keep enum tokens, field labels, format examples and counterparty names verbatim (First
          Lien, Project Finance, Amend & Extend, Yes, 2.000%, M/D/YYYY). Do not paraphrase them.
        - Keep the rationale when the messages state one; it is what lets a future reader judge
          whether the rule still applies.
        - Drop the per-deal specifics: issuer names, ids, one-off amounts, the date of the
          correction.
        - Do NOT incorporate external knowledge. Do NOT invent a trigger or a rationale the
          messages do not state.
        - Avoid duplicate extractions.
        - If the messages contain no generalizable rule, return an empty list. An empty list is the
          correct and expected answer for chatter and for a discussion of a single deal.

        <language_requirement>
        - Identify the main language of the messages and declare it in the "language" field of the
          JSON output.
        - Write the rule in that language. Keep identifiers, enum-like tokens (for example
          First Lien or Project Finance), field labels, and proper nouns verbatim regardless of the
          main language; they do not count toward language detection.
        - If the messages are in English, respond in English.
        </language_requirement>
      EOT
    }
  }
}
