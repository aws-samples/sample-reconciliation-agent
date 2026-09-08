####################################################################################
# Adoption of AgentCore resources that used to be managed out-of-band.
#
# Terraform only allows `import` blocks in the ROOT module, which is why these live here rather
# than beside the resources they adopt (the matching `removed` blocks DO live in the module, since
# those must sit where the old resource was declared).
#
# Every import here replaces a `null_resource` + AWS CLI shim with a native resource pointing at
# the SAME live object, so the cutover is state-only: no delete, no recreate, no window where the
# gateway has no target.
#
# ⚠️ These blocks are single-use for THIS environment. Once applied, the resources are in state and
# the import is a no-op — but a fresh environment has nothing to adopt and Terraform errors on an
# import whose target does not exist. Delete this file (or gate it) before standing up a second
# environment from the same root.
####################################################################################

# Ingress gateway -> Tier-2 runtime (http/agentcoreRuntime).
# Live id confirmed 2026-09-02: target `recon-agent` = R7T4IRRCFA, status READY.
import {
  to = module.recon_agent.aws_bedrockagentcore_gateway_target.ingress_agent
  id = "recon-dev-ingress-gateway-zodyfhvmrl,R7T4IRRCFA"
}

# Egress gateway -> Microsoft Graph (OpenAPI schema, OAUTH outbound).
# Live id confirmed 2026-09-02: target `microsoft-graph` = C9RY0NGGSC, status READY.
#
# The target is adopted, but its OAuth2 credential provider CANNOT be (Name is create-only on the
# CFN type) — see the manual delete-oauth2-credential-provider step in the module. The provider ARN
# is name-derived, so the adopted target still points at the right place afterwards.
import {
  to = module.graph.aws_bedrockagentcore_gateway_target.graph[0]
  id = "recon-dev-gateway-pxtdq03jm5,C9RY0NGGSC"
}

# Egress gateway -> IDP document-extraction MCP server (OAUTH client-credentials outbound).
# Live id confirmed 2026-09-02: target `document-extraction` = RATDBFCK4P, status READY.
# Same provider caveat as Graph above.
import {
  to = module.recon_agent.aws_bedrockagentcore_gateway_target.idp[0]
  id = "recon-dev-gateway-pxtdq03jm5,RATDBFCK4P"
}
