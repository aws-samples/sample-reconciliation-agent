#!/usr/bin/env python3
"""Export ``harness_config.cfn_config()`` to the committed ``harness_config.json``.

The harness is created by AWS::BedrockAgentCore::Harness inside an aws_cloudformation_stack
(``infra/modules/recon-agent-harness``). Terraform cannot import Python, so the settings that used
to be read by ``manage_harness.py`` — tools, allowedTools, maxIterations, the lifecycle timeouts —
are exported here for HCL to read with ``jsondecode(file(...))``.

``harness_config.py`` remains the authored source of truth; this file's output is DERIVED and
committed only so that Terraform needs no interpreter at plan or apply time. That is the whole
point: nothing in an apply may depend on python3 being present.

Run after editing harness_config.py:

    python3 infra/scripts/gen_harness_config_json.py

``tests/harness_agent/test_harness_config_json.py`` compares the committed file against a fresh
render, so forgetting to run this is a failing test rather than a silently stale harness.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# The blueprint dir is not an installed package — it is added to sys.path by pytest
# (pyproject.toml pythonpath). Do the same here so the script is runnable from the repo root with
# no environment setup.
BLUEPRINT_DIR = Path(__file__).resolve().parents[2] / "agent-blueprint" / "recon-agent-harness"
sys.path.insert(0, str(BLUEPRINT_DIR))

import harness_config  # noqa: E402  (import follows the sys.path insert above, by necessity)

OUTPUT_PATH = BLUEPRINT_DIR / "harness_config.json"


def render() -> str:
    """Serialize the CFN projection exactly as it is committed.

    Formatting is pinned (2-space indent, sorted keys, trailing newline) so the contract test can
    compare bytes and so a regeneration produces no incidental diff.

    :returns: the full file contents, including the trailing newline.
    """
    return json.dumps(harness_config.cfn_config(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    """Write harness_config.json beside harness_config.py and report the path.

    :returns: process exit code (0).
    """
    contents = render()
    OUTPUT_PATH.write_text(contents, encoding="utf-8")
    print(f"wrote {OUTPUT_PATH} ({len(contents)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
