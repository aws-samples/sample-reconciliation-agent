variable "name_prefix" {
  description = "Prefix applied to all resource names (e.g. recon-dev)."
  type        = string
  default     = "recon-dev"
}

variable "agent_model_id" {
  description = "Initial value seeded into the /agent-model-id parameter the Config tab then owns. Only ever read on the first apply — the lifecycle block ignores later drift, so changing this does NOT change a deployed environment's selection."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}
