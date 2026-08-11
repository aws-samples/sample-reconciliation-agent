variable "name_prefix" {
  description = "Prefix applied to all resource names (e.g. recon-dev)."
  type        = string
  default     = "recon-dev"
}

variable "hosted_ui_prefix" {
  description = "Cognito Hosted UI domain prefix (must be globally unique)."
  type        = string
}

variable "callback_urls" {
  description = "OAuth callback URLs for the SPA client (CloudFront domain + /callback). May be empty on first apply and set once CloudFront exists."
  type        = list(string)
  default     = ["https://localhost:3000/callback"]
}

variable "logout_urls" {
  description = "OAuth logout URLs for the SPA client."
  type        = list(string)
  default     = ["https://localhost:3000/"]
}
