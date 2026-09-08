"""Intake Lambda: validate a structured/semi-structured dataset and persist ReconItems.

There is no normalization stage — the payload is already structured. Malformed payloads are
rejected loudly (400); valid items are written conditionally so resubmissions do not re-fire
the downstream Tier-1 stream consumer for items already in flight.
"""

import json
import os

from pydantic import ValidationError

from backend.recon_core.ddb import ItemStore
from backend.recon_core.schema import ReconItem


def handle(event, _context):
    """API Gateway proxy handler: validate the payload and write ReconItems.

    Expects a JSON body ``{"domain": str, "items": [ {item_id, sides, ...}, ... ]}``.
    Returns 202 with the count of newly written items, or 400 on a malformed payload. Either the
    whole batch is written or none of it is.
    """
    try:
        payload = json.loads(event["body"])
        domain, raw_items = payload["domain"], payload["items"]
        if not raw_items:
            raise ValueError("items must be non-empty")
    except (KeyError, ValueError, TypeError) as exc:
        return {"statusCode": 400, "body": json.dumps({"error": str(exc)})}

    # Validate the WHOLE batch before writing any of it. Constructing ReconItem inside the write loop
    # instead would let a bad item 4 escape as an unhandled Lambda exception with items 1-3 already
    # written and Tier-1 already running on them: the caller sees a 502 and cannot tell "rejected" from
    # "half-accepted", and because put_if_absent skips existing ids, the retry then reports
    # `written: 0` — indistinguishable from "nothing happened". This endpoint is reachable from a
    # hand-typed UI payload, so a partly-invalid batch is the expected input, not a theoretical one.
    try:
        items = [ReconItem(domain=domain, **raw) for raw in raw_items]
    except ValidationError as exc:
        # errors(include_url=False): the default rendering appends an errors.pydantic.dev URL per
        # error, which is noise in a UI toast.
        return {
            "statusCode": 400,
            "body": json.dumps({"error": f"invalid item: {exc.errors(include_url=False)}"}),
        }
    except TypeError as exc:
        # `**raw` on a non-mapping (e.g. a JSON array of strings) raises before pydantic sees it.
        return {"statusCode": 400, "body": json.dumps({"error": f"invalid item: {exc}"})}

    store = ItemStore(table_name=os.environ.get("ITEMS_TABLE", "recon-items"))
    # conditional put: a resubmitted item_id is skipped, not overwritten, so re-submission never
    # re-fires the Tier-1 stream consumer for an existing item
    written = sum(1 for item in items if store.put_if_absent(item))
    return {"statusCode": 202, "body": json.dumps({"written": written})}
