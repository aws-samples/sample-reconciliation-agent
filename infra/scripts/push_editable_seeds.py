#!/usr/bin/env python3
"""Operator entry point for seed reconciliation: read the repo files, then run the shared rules.

The rules themselves — the four seed-push outcomes, the ETag/marker fingerprint comparison, and
the failure messages — live in ``infra/modules/deploy-actions/src/seed_push.py``, because the
deploy-actions Lambda runs the same reconciliation during `terraform apply`. Keeping one copy is the
point: an operator resolving a conflict by hand and the apply that reported it must agree about what
counts as a conflict.

This script exists for the by-hand case. Terraform does not call it; the apply invokes the Lambda,
which imports the same module. All this adds is reading the seed files off disk, which is the one thing
a Lambda cannot do.

Usage (from the repo root):

    BUCKET=recon-dev-assets \\
    SEEDS='{"system-prompt.md": "agent-blueprint/recon-agent/system-prompt.md"}' \\
      python3 infra/scripts/push_editable_seeds.py

    BUCKET  the assets bucket name
    REGION  optional; defaults to the ambient AWS region
    SEEDS   JSON object, {"<bucket key>": "<repo file path>"}

Exit codes: 0 = everything reconciled; 1 = at least one key needs a human; 2 = incomplete
environment. Every failing key is reported in one pass, each with the two commands that resolve it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import boto3

# seed_push ships beside the Lambda handler rather than in this directory, so that the deployment zip
# contains it. Add that directory to the path rather than duplicating the rules here.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "modules" / "deploy-actions" / "src"))

import seed_push  # noqa: E402  (import follows the sys.path insert, by necessity)


def main() -> int:
    """Read every seed named in `SEEDS` off disk and reconcile it.

    :returns: process exit code — 0 reconciled, 1 needs a human, 2 incomplete environment.
    """
    try:
        bucket = os.environ["BUCKET"]
        sources: dict[str, str] = json.loads(os.environ["SEEDS"])
    except KeyError as exc:
        print(f"ERROR: missing required environment variable {exc}", file=sys.stderr)
        return 2

    region = os.environ.get("REGION")
    s3 = boto3.client("s3", region_name=region) if region else boto3.client("s3")

    # Read the content here so the shared rules never touch the filesystem — the Lambda caller has
    # no checkout, and a filesystem read in the shared module would work locally and fail there.
    seeds = {
        key: {"content": Path(path).read_text(encoding="utf-8"), "source": path}
        for key, path in sources.items()
    }

    try:
        results = seed_push.reconcile(s3=s3, bucket=bucket, seeds=seeds)
    except seed_push.SeedPushError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    for key in sorted(results):
        print(f"[seed-push] {results[key]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
