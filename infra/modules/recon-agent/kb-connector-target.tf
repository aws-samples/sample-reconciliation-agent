####################################################################################
# `managed-kb` gateway target: the Bedrock managed Knowledge Base reached through the
# AgentCore Gateway's built-in `bedrock-knowledge-bases` connector.
#
# ⚠️ WHY THERE IS CLOUDFORMATION IN A PURE-TERRAFORM REPO
#
# This is the ONE resource in the platform Terraform cannot express. A connector target needs
# targetConfiguration.mcp.connector, and no AWS provider version models it: aws 6.56.0 (pinned)
# and 6.62.0 both expose only api_gateway / lambda / mcp_server / open_api_schema / smithy_model
# under target_configuration.mcp, and awscc 1.98.0 has no gateway-target resource at all. The
# CloudFormation resource AWS::BedrockAgentCore::GatewayTarget does model it, with full CRUD
# handlers and only GatewayIdentifier create-only -- so ParameterOverrides can be tuned in place.
#
# Do NOT "fix" this by porting it to aws_bedrockagentcore_gateway_target. Check the provider's
# target_configuration.mcp schema first; if a `connector` block has appeared, the port is real
# and this file can go. Until then the port silently loses the connector and the whole feature.
#
# One further upside: aws_cloudformation_stack diffs on template_body/parameters only, so the
# service-injected MetadataConfiguration.allowed_request_headers cannot produce the perpetual
# diff that forced `lifecycle { ignore_changes = [metadata_configuration] }` on the
# Terraform-native targets elsewhere in this module.
####################################################################################

locals {
  # ⚠️ This string is the ONLY documentation the model ever sees for the filter parameter.
  #
  # On the runtime backend a Python wrapper (strands_investigator.build_guidance_filter) assembles
  # the filter from typed arguments, but the harness backend has no wrapper -- the model there
  # emits raw Bedrock filter JSON against this description alone. So it has to name every
  # filterable key WITH its type: a STRING_LIST queried with `equals`, or a NUMBER queried with a
  # quoted string, returns zero results and HTTP 200. Nothing raises. The agent reads that as "no
  # guidance exists for this break".
  #
  # Keep this in step with the sidecars under data/kb-seed/ (tests/kb_seed/ is their contract). A
  # key named here but absent from the sidecars silently matches nothing; a key present in the
  # sidecars but unnamed here is dead weight the agent will never reach for.
  #
  # ⚠️ Nothing here is typed BOOLEAN, and nothing ever may be: a BOOLEAN attribute in a sidecar
  # makes the managed KB's S3 connector DISCARD the document, reporting only "Some documents could
  # not be crawled" on an otherwise COMPLETE job (verified live 2026-08-26). has_attachments is
  # therefore a STRING of "true"/"false", which is why the wording below is explicit about it.
  # tests/kb_seed/test_metadata_sidecars.py::test_no_sidecar_declares_a_boolean_attribute enforces
  # this on the corpus side.
  kb_filter_description = <<-EOT
    Metadata filter over the guidance corpus. Attributes are per document kind, and filtering on
    an attribute a document does not carry EXCLUDES that document.

    All kinds: doc_type (STRING: playbook | email | email_attachment), break_class (STRING LIST:
    timing | tolerance | aggregation | missing_reference | unknown -- use listContains, never
    equals), skill (STRING LIST), effective_date (NUMBER, YYYYMMDD).
    playbook only: autonomy (STRING).
    email and email_attachment: message_id (STRING), sender (STRING), receiver (STRING LIST),
    subject (STRING), received_date (NUMBER, YYYYMMDD).
    email only: has_attachments (STRING: "true" | "false" -- a STRING, not a boolean, so compare
    against the quoted word). email_attachment only: attachment_format (pdf | xlsx).

    An attachment repeats its parent email's message_id, sender, receiver, subject and
    received_date, so equals on message_id narrows to one message bundle. Note the filter only
    narrows the CANDIDATES: results are still ranked by relevance to your query text and a weakly
    matching document is dropped even when the filter admits it. If you filtered to a message and
    the attachment did not come back, ask again with query text describing the attachment.

    Provide exactly one operator at each level; combine with andAll or orAll. Operators: equals,
    notEquals, listContains, in, notIn, greaterThan, greaterThanOrEquals, lessThan,
    lessThanOrEquals. There is NO stringContains and NO startsWith on a managed knowledge base:
    every string match is exact-match or set-membership. Using either one fails the call outright
    rather than returning nothing, so you will see the error.
  EOT
}

resource "aws_cloudformation_stack" "kb_connector_target" {
  name = "${var.name_prefix}-kb-connector-target"

  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Description              = "AgentCore Gateway connector target for the managed Bedrock KB (managed by Terraform; see kb-connector-target.tf)."

    Resources = {
      Target = {
        Type = "AWS::BedrockAgentCore::GatewayTarget"
        Properties = {
          Name              = "managed-kb"
          GatewayIdentifier = aws_bedrockagentcore_gateway.this.gateway_id
          Description       = "Bedrock managed knowledge base via the bedrock-knowledge-bases connector (Retrieve, with agent-driven metadata filtering)."

          # The gateway calls Bedrock with its OWN role, so the bedrock:Retrieve and
          # bedrock:GetKnowledgeBase grants below are what make this work.
          CredentialProviderConfigurations = [{ CredentialProviderType = "GATEWAY_IAM_ROLE" }]

          TargetConfiguration = {
            Mcp = {
              Connector = {
                # No Source.Version: bedrock-knowledge-bases has exactly one version (1.0.0), and
                # neither the CFN schema nor botocore 1.43.67 models a version field here. The
                # '1.1.0' in circulated snippets belongs to the WEB-SEARCH connector and would be
                # a ValidationException.
                Source = { ConnectorId = "bedrock-knowledge-bases" }

                # Retrieve only. AgenticRetrieveStream would need bedrock:AgenticRetrieveStream on
                # Resource "*", which is exactly the grant we do not want on the gateway role.
                Enabled = ["Retrieve"]

                Configurations = [{
                  # Must equal the backend operation name.
                  Name = "Retrieve"

                  # Admin-bound values. knowledgeBaseId is deliberately NOT in ParameterOverrides:
                  # an exposed override REPLACES the admin value, so keeping it out of that list is
                  # the entire trust boundary -- it is what stops an agent pointing this tool at
                  # some other knowledge base.
                  ParameterValues = {
                    knowledgeBaseId = aws_bedrockagent_knowledge_base.managed.id
                    retrievalConfiguration = {
                      # ManagedSearchConfiguration has EXACTLY four members (verified against
                      # botocore 1.43.67): filter, numberOfResults, rerankingConfiguration,
                      # rerankingModelType.
                      #
                      # ⚠️ There is NO overrideSearchType on the managed branch -- that belongs to
                      # vectorSearchConfiguration (the customer-managed one). A managed KB owns its
                      # vector store and exposes no search-type knob. Because ParameterValues is a
                      # free-form document, setting it would very plausibly be accepted at CREATE
                      # time and then fail on every RETRIEVE.
                      #
                      # ⛔ DO NOT put `numberOfResults` back here. It was `numberOfResults = 5` and
                      # that broke every unfiltered retrieval, live, on 2026-08-27:
                      #
                      #   ValidationException: Field '/retrievalConfiguration/
                      #   managedSearchConfiguration/numberOfResults' has invalid type:
                      #   string found, integer expected
                      #
                      # jsonencode() emits a JSON number, but CloudFormation coerces scalars inside
                      # a free-form property document to STRINGS, so GetGatewayTarget reports
                      # `"numberOfResults": "5"` and Bedrock rejects it. That is a property of
                      # provisioning this target through CFN (see the header note on why we do) and
                      # cannot be fixed by quoting or unquoting it here.
                      #
                      # It only surfaced on calls that omit `retrievalConfiguration` entirely --
                      # i.e. the wrapper's own default, `search_guidance(query=...)` with no facets.
                      # An agent-supplied `managedSearchConfiguration` REPLACES this whole object
                      # rather than merging into it, which is why a filtered call sidestepped the
                      # bad value and looked fine. Omitting it lets Bedrock apply its own default
                      # of 5, which is exactly what the numberOfResults override below promises.
                      #
                      # Note the asymmetry, both observed live 2026-08-27: an ADMIN "5" here is
                      # fatal, but an AGENT that sends numberOfResults: "10" (a JSON string) on the
                      # override path is fine -- a harness run did exactly that and got 10 results.
                      # The overrides are typed by the generated inputSchema, so a string is coerced
                      # to the integer it declares; ParameterValues is a free-form document with no
                      # schema to coerce against, so whatever CFN stored is what Bedrock receives.
                      # Do not conclude from a working agent call that this key would be safe here.
                      #
                      # Same replacement rule means `rerankingModelType` below is in force ONLY on
                      # calls that send no managedSearchConfiguration of their own. It is kept
                      # because "NONE" is also the API default, so being dropped changes nothing --
                      # but do not read it as a guarantee that reranking is off on every call.
                      managedSearchConfiguration = {
                        rerankingModelType = "NONE"
                      }
                    }
                    # No static `filter` here. An agent-supplied override replaces the admin value
                    # wholesale, so a static filter sitting next to an exposed filter override
                    # looks like a security boundary and is not one.
                  }

                  # ✅ VERIFIED 2026-08-26: the JSONPath absolute form below is the correct one.
                  # Three mutually incompatible forms are documented (JSONPath absolute, JSON
                  # Pointer relative, JSON Pointer absolute) and an unrecognised Path is SILENTLY
                  # IGNORED: the target still reaches READY, the agent just never sees the
                  # parameter and every retrieval runs unfiltered. Nothing errors. So if you change
                  # a Path, the gate is tools/list (scripts/mcp_tools_list.py), not target status.
                  #
                  # ⚠️ These paths generate a NESTED inputSchema mirroring the Retrieve API, NOT
                  # three flat arguments. Callers must send
                  #   {"retrievalQuery": {"text": ...},
                  #    "retrievalConfiguration": {"managedSearchConfiguration": {"filter": ...,
                  #                                                              "numberOfResults": ...}}}
                  # with retrievalQuery the only required member. scripts/mcp_tool_call.py builds
                  # exactly that shape and is how a filter is verified end to end -- tools/list only
                  # proves the parameter is advertised, not that it does anything.
                  #
                  # UpdateGatewayTarget covers ParameterOverrides, so tuning these is an in-place
                  # update, not a recreate.
                  ParameterOverrides = [
                    {
                      Path        = "$.retrievalQuery.text"
                      Description = "The natural-language question to retrieve guidance for."
                      Visible     = true
                    },
                    {
                      Path        = "$.retrievalConfiguration.managedSearchConfiguration.numberOfResults"
                      Description = "How many passages to return (1-100). Defaults to 5."
                      Visible     = true
                    },
                    {
                      Path        = "$.retrievalConfiguration.managedSearchConfiguration.filter"
                      Description = local.kb_filter_description
                      Visible     = true
                    },
                  ]
                }]
              }
            }
          }
        }
      }
    }

    # /properties/TargetId is in the resource's readOnlyProperties, so GetAtt resolves it.
    Outputs = {
      TargetId = {
        Description = "Gateway target id, for get-gateway-target readiness polling."
        Value       = { "Fn::GetAtt" = ["Target", "TargetId"] }
      }
    }
  })
}

# Block until the target actually reaches READY.
#
# ⚠️ This is not belt-and-braces. Target validation is ASYNCHRONOUS (~30s, and it includes the
# GetKnowledgeBase call the IAM grant above exists for), and CloudFormation's create handler is
# not documented to wait for the target to leave CREATING. So the stack can return
# CREATE_COMPLETE while the gateway's tool surface is still empty.
#
# That matters because AgentCore Policy validates every Cedar action name against the LIVE tool
# surface. Naming an action whose tool is not yet visible fails with "unrecognized action" and
# leaves the policy in UPDATE_FAILED -- and Cedar fails closed, so an UPDATE_FAILED recon_reads
# costs the agent EVERY read tool, not just this one. That exact failure hit this repo on
# 2026-08-08 for a different target.
#
# aws_bedrockagentcore_policy.reads therefore depends_on THIS resource, not on the stack.
# Forget the retired CLI poll (no destroy provisioner; see the note on the sibling gate).
removed {
  from = null_resource.kb_connector_target_ready

  lifecycle {
    destroy = false
  }
}

resource "aws_lambda_invocation" "kb_connector_target_ready" {
  function_name = var.deploy_actions_function_name

  input = jsonencode({
    action             = "wait_gateway_target"
    gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
    target_id          = aws_cloudformation_stack.kb_connector_target.outputs["TargetId"]
    # Re-run the wait when the actor's code changes, not only when the target id does.
    handler_version = var.deploy_actions_source_code_hash
  })
}
