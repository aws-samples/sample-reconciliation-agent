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
  # One list for every backend Lambda, because local.staging_dir is "${path.module}/.build/staging"
  # and path.module is the module SOURCE directory — shared by every instance. A second instance
  # of this module with its own dependency set would stage into the same directory and rm -rf the
  # first one's work. So a Lambda that needs a dependency adds it here, and every zip grows.
  #
  # PyYAML: backend/recon_core/skill_meta.py parses SKILL.md frontmatter as real YAML.
  # extract-msg, reportlab: backend/email_preprocess reads Outlook .msg containers and renders
  # email bodies to PDF, because neither upload destination can read an email.
  #
  # Changing this list alters local.stage_hash, so the shared zip is rebuilt and every backend
  # Lambda gets a new source_code_hash on the next apply — in-place updates, no deletes.
  #
  # ⚠️ This list is duplicated in .gitlab-ci.yml's pre-plan staging call, which passes it as
  # arguments to stage.sh. The two MUST agree, and drift between them is silent: archive_file reads
  # the staging directory at PLAN time, so whatever CI staged is what ships, and terraform_data.stage's
  # hash already matches at apply time and will not re-stage to correct it. A dependency missing from
  # the CI copy therefore surfaces only as an ImportError at runtime.
  #
  # red-black-tree-mod is listed although nothing imports it. extract-msg depends on it, and it
  # is published as a source distribution only -- which the platform-pinned pip install in
  # stage.sh cannot install, because --platform forces --only-binary=:all:. stage.sh builds a
  # wheel for any listed requirement that lacks one, and it can only see requirements that are
  # listed, so a transitive sdist-only package has to be named here to be reachable. Pinned
  # inside extract-msg 0.56.1's own >=1.20,<=1.23 range.
  default = [
    "pydantic==2.13.0",
    "PyYAML==6.0.3",
    "extract-msg==0.56.1",
    "reportlab==5.0.1",
    "red-black-tree-mod==1.22",
  ]
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
