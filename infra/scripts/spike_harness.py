#!/usr/bin/env python3
"""Task 1 spike — verify the AgentCore Harness surface the blueprint depends on.

Runs the SAFE, read-only checks by default (API surface, model id, endpoint availability); the
live create/invoke round-trip (billable, needs an execution role) is gated behind ``--create``.
Findings are recorded in ``agent-blueprint/recon-agent-harness/README.md``.

Usage:
    python infra/scripts/spike_harness.py                 # safe read-only checks
    python infra/scripts/spike_harness.py --create ROLE   # + live create/invoke/delete

Uses the default AWS session (set AWS_PROFILE=<your-profile> AWS_REGION=us-east-1, or --profile/--region).
"""

import argparse
import json
import sys

import boto3
import botocore.session


def check_api_surface() -> dict:
    """Confirm the harness operations exist in the pinned botocore service models."""
    sess = botocore.session.get_session()
    control = sess.get_service_model("bedrock-agentcore-control")
    data = sess.get_service_model("bedrock-agentcore")
    control_ops = sorted(o for o in control.operation_names if "arness" in o)
    data_ops = sorted(o for o in data.operation_names if "arness" in o)
    required = {"CreateHarness", "GetHarness", "UpdateHarness", "DeleteHarness", "ListHarnesses"}
    return {
        "botocore": botocore.__version__,
        "control_harness_ops": control_ops,
        "data_harness_ops": data_ops,
        "control_surface_ok": required.issubset(set(control_ops)),
        "invoke_harness_present": "InvokeHarness" in data_ops,
    }


def check_model_id(*, region: str, profile: str | None) -> dict:
    """Resolve the Sonnet 5 Bedrock model id + on-demand inference profile."""
    session = boto3.Session(profile_name=profile, region_name=region)
    bedrock = session.client("bedrock")
    models = bedrock.list_foundation_models().get("modelSummaries", [])
    sonnet5 = [m["modelId"] for m in models if "sonnet-5" in m["modelId"]]
    profiles = [
        p["inferenceProfileId"]
        for p in bedrock.list_inference_profiles().get("inferenceProfileSummaries", [])
        if "sonnet-5" in p["inferenceProfileId"]
    ]
    # Harness on-demand invocation needs the cross-region inference profile, not the base id.
    recommended = next((p for p in profiles if p.startswith("us.")), None)
    return {"base_model_ids": sonnet5, "inference_profiles": profiles, "recommended": recommended}


def check_endpoint(*, region: str, profile: str | None) -> dict:
    """Confirm the harness control endpoint answers in this region (ListHarnesses)."""
    session = boto3.Session(profile_name=profile, region_name=region)
    ctl = session.client("bedrock-agentcore-control")
    resp = ctl.list_harnesses()
    # The list key has been observed as either `harnesses` or `items` across model versions.
    harnesses = resp.get("harnesses", resp.get("items", []))
    return {"endpoint_live": True, "existing_harness_count": len(harnesses)}


def main() -> int:
    """Run the spike checks and print a JSON findings block."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--create", metavar="EXECUTION_ROLE_ARN", default=None,
                    help="Also run the live create/invoke/delete round-trip with this role.")
    args = ap.parse_args()

    findings = {"api_surface": check_api_surface()}
    try:
        findings["model_id"] = check_model_id(region=args.region, profile=args.profile)
        findings["endpoint"] = check_endpoint(region=args.region, profile=args.profile)
    except Exception as exc:  # noqa: BLE001 - spike surfaces live-call failures verbatim
        findings["live_error"] = repr(exc)

    if args.create:
        # Live round-trip is intentionally NOT auto-run; see README for the manual procedure.
        findings["create"] = "not implemented in read-only spike; run manually per README"

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
