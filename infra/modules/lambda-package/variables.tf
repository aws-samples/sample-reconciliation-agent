variable "backend_dir" {
  description = "Path to the backend/ source directory to package (absolute, or relative to the directory terraform runs in)."
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
  # Empty by default because the two deal-pipeline Lambdas use boto3 (supplied by the runtime)
  # and the standard library only; with an empty list stage.sh never calls pip. A Lambda that
  # grows a real dependency adds it here, and stage.sh installs it as a wheel for var.lambda_platform.
  #
  # One list for every Lambda, because local.staging_dir is "${path.module}/.build/staging" and
  # path.module is the module SOURCE directory — shared by every instance. A second instance of
  # this module with its own dependency set would stage into the same directory and rm -rf the
  # first one's work.
  #
  # Changing this list alters local.stage_hash, so the zip is rebuilt and both Lambdas get a new
  # source_code_hash on the next apply — in-place updates, no deletes.
  #
  # A dependency that is published as a source distribution only cannot be installed by the
  # platform-pinned pip in stage.sh (--platform forces --only-binary=:all:). stage.sh builds a
  # wheel for any LISTED requirement that lacks one, and it can only see requirements that are
  # listed, so a transitive sdist-only package has to be named here as well to be reachable.
  default = []
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
