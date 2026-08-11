"""Intake Lambda: validate a structured/semi-structured dataset and persist ReconItems.

There is no normalization stage — the payload is already structured. Malformed payloads are
rejected loudly (400); valid items are written conditionally so resubmissions do not re-fire
the downstream Tier-1 stream consumer for items already in flight.
"""

import json
import os

from backend.recon_core.ddb import ItemStore
from backend.recon_core.schema import ReconItem


def handle(event, _context):
    """API Gateway proxy handler: validate the payload and write ReconItems.

    Expects a JSON body ``{"domain": str, "items": [ {item_id, sides, ...}, ... ]}``.
    Returns 202 with the count of newly written items, or 400 on a malformed payload.
    """
    try:
        payload = json.loads(event["body"])
        domain, raw_items = payload["domain"], payload["items"]
        if not raw_items:
            raise ValueError("items must be non-empty")
    except (KeyError, ValueError, TypeError) as exc:
        return {"statusCode": 400, "body": json.dumps({"error": str(exc)})}

    store = ItemStore(table_name=os.environ.get("ITEMS_TABLE", "recon-items"))
    written = 0
    for raw in raw_items:
        # conditional put: a resubmitted item_id is skipped, not overwritten, so
        # re-submission never re-fires the Tier-1 stream consumer for an existing item
        if store.put_if_absent(ReconItem(domain=domain, **raw)):
            written += 1
    return {"statusCode": 202, "body": json.dumps({"written": written})}
