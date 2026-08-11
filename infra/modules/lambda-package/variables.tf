variable "backend_dir" {
  description = "Absolute path to the backend/ source directory to package."
  type        = string
}

variable "name" {
  description = "Base name for the output zip (e.g. \"backend\")."
  type        = string
  default     = "backend"
}

variable "runtime_dependencies" {
  description = "Third-party pip deps to vendor into the zip. boto3/botocore are provided by the Lambda runtime and must NOT be listed here."
  type        = list(string)
  default     = ["pydantic==2.13.0"]
}

variable "lambda_platform" {
  description = "pip --platform tag matching the Lambda architecture (x86_64 -> manylinux2014_x86_64; arm64 -> manylinux2014_aarch64)."
  type        = string
  default     = "manylinux2014_x86_64"
}

variable "lambda_python_version" {
  description = "pip --python-version matching the Lambda runtime."
  type        = string
  default     = "3.12"
}
