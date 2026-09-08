#!/usr/bin/env bash
# Stage backend/ plus the vendored pip dependencies into <staging_dir>, ready for
# data.archive_file.lambda to zip.
#
# This is a committed script rather than an inline local-exec heredoc because it has two
# callers, and they run at different points in Terraform's lifecycle:
#
#   1. terraform_data.stage's local-exec (main.tf) -- at APPLY time.
#   2. CI, and anyone planning from a fresh checkout -- BEFORE `terraform plan`.
#
# The second caller is the reason this must be reusable. data.archive_file.lambda reads
# source_dir at PLAN time, but the provisioner that fills it only runs at APPLY time, and
# .build/ is gitignored. So a checkout that has never applied (every CI runner, every new
# git worktree) fails to plan with "could not archive missing directory" until this has run
# once. Duplicating the logic in the pipeline would leave two copies to drift apart; calling
# this script keeps the zip's contents defined in exactly one place.
#
# Changing this file does NOT re-trigger staging on its own: terraform_data.stage keys on
# local.stage_hash (backend sources + dependency set + platform + python version), not on
# the script body. That is deliberate -- editing a comment here must not repackage and
# redeploy every backend Lambda.
#
# Usage:
#   stage.sh <staging_dir> <backend_dir> <lambda_platform> <lambda_python_version> [dep...]

set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <staging_dir> <backend_dir> <lambda_platform> <lambda_python_version> [runtime_dep...]" >&2
  exit 2
fi

STAGING_DIR="$1"
BACKEND_DIR="$2"
LAMBDA_PLATFORM="$3"
LAMBDA_PYTHON_VERSION="$4"
shift 4
# Remaining arguments are the pip requirement specifiers to vendor. An empty list is valid:
# the caller may want the backend sources with no third-party deps at all.
RUNTIME_DEPENDENCIES=("$@")

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "ERROR: backend dir not found: $BACKEND_DIR" >&2
  exit 1
fi

# Rebuild from scratch so a removed source file cannot survive in the zip.
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/backend"

# backend/ is staged NESTED, as $STAGING_DIR/backend/, because archive_file puts a
# directory's *contents* at the zip root. Handlers import `backend.<pkg>.<module>`, so the
# zip root has to hold a backend/ package directory, not backend/'s contents.
rsync -a --delete \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.venv' \
  --exclude '.build' \
  --exclude '.ruff_cache' \
  --exclude '.pytest_cache' \
  "$BACKEND_DIR/" "$STAGING_DIR/backend/"

# Vendored deps go at the staging ROOT so they are top-level importable (e.g. `pydantic`).
# boto3/botocore are supplied by the Lambda runtime and must not be vendored.
#
# --platform/--python-version/--only-binary pin the wheels to the LAMBDA architecture rather
# than the build host's: pydantic ships the compiled pydantic_core extension, so a macOS or
# CI-runner wheel would not load on Lambda.
#
# --only-binary=:all: is not a choice: pip REFUSES --platform without it, because it cannot
# know what architecture a source distribution would compile for. The consequence is that a
# requirement published as an sdist only cannot be installed by that command at all -- the run
# dies with "No matching distribution found", naming a package nobody put in the list, because
# it is a dependency of a dependency. red-black-tree-mod, which extract-msg pulls in, is one.
#
# The loop below is the escape hatch. Any listed requirement with no installable wheel gets one
# built here, into a directory pip is then pointed at with --find-links. That is safe for
# exactly the packages it fires on, and the check afterwards is what keeps it that way: a wheel
# tagged anything other than py3-none-any was compiled for the BUILD host, would not import on
# Lambda, and stops the build instead of shipping.
#
# This only reaches a TRANSITIVE sdist-only dependency if that dependency is also named in the
# list -- the probe asks pip about each requirement with --no-deps. So such a package is pinned
# explicitly in variables.tf even though nothing imports it directly.
if [[ ${#RUNTIME_DEPENDENCIES[@]} -gt 0 ]]; then
  WHEELHOUSE="$(mktemp -d)"
  trap 'rm -rf "$WHEELHOUSE"' EXIT

  for dep in "${RUNTIME_DEPENDENCIES[@]}"; do
    if python3 -m pip download \
      --no-deps --quiet \
      --platform "$LAMBDA_PLATFORM" \
      --python-version "$LAMBDA_PYTHON_VERSION" \
      --implementation cp \
      --only-binary=:all: \
      --dest "$WHEELHOUSE/probe" \
      "$dep" >/dev/null 2>&1; then
      continue
    fi
    echo "note: $dep publishes no wheel for $LAMBDA_PLATFORM; building one locally" >&2
    python3 -m pip wheel --no-deps --quiet --wheel-dir "$WHEELHOUSE" "$dep"
  done
  # The probe downloads are throwaway -- they exist only to answer "does a wheel exist". Left in
  # place they would join the --find-links directory and pin every dependency to whatever the
  # probe happened to fetch, which is the same set pip would resolve anyway but silently frozen.
  rm -rf "$WHEELHOUSE/probe"

  for wheel in "$WHEELHOUSE"/*.whl; do
    [[ -e "$wheel" ]] || break
    if [[ "$wheel" != *-none-any.whl ]]; then
      echo "ERROR: $(basename "$wheel") was built locally and is not architecture-neutral." >&2
      echo "       It would be a $(uname -m) binary inside a Lambda zip for $LAMBDA_PLATFORM." >&2
      echo "       Vendor a package that publishes wheels instead." >&2
      exit 1
    fi
  done

  python3 -m pip install \
    --platform "$LAMBDA_PLATFORM" \
    --python-version "$LAMBDA_PYTHON_VERSION" \
    --implementation cp \
    --only-binary=:all: \
    --find-links "$WHEELHOUSE" \
    --target "$STAGING_DIR" \
    "${RUNTIME_DEPENDENCIES[@]}"
fi

find "$STAGING_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$STAGING_DIR" -type d -name '*.dist-info' -prune -exec rm -rf {} +

# Excluding __pycache__ leaves behind any source directory whose only remaining content WAS a
# cache -- e.g. a stale untracked backend/<deleted-module>/__pycache__ arrives as an empty
# directory and archive_file records it, so the zip differs between two checkouts of the same
# commit. Any empty directory here is dead weight regardless: a Python package carries an
# __init__.py, and a vendored wheel always ships files. -depth so parents empty out first.
find "$STAGING_DIR" -depth -type d -empty -delete
