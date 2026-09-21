"""Lambda ``<name_prefix>-pipeline-oms-upload``: the mock OMS that receives an approved staging CSV.

Invoked synchronously by the BFF's approve route with ``{"deal_id": ...}``. Reads the deal's CSV
from S3, validates it with :mod:`oms_validator`, and records the outcome on the deal:

- accepted: the file is copied to ``oms-staging/<deal_id>.csv``, status ``UPLOADED``, history
  ``UPLOAD_ACCEPTED``;
- rejected: status ``UPLOAD_FAILED``, history ``UPLOAD_REJECTED`` naming the error codes.

Environment: ``DEALS_TABLE``, ``ASSETS_BUCKET``, ``COUNTERPARTIES_KEY`` (the canonical
counterparty CSV the ``LEFT_AGENT_UNKNOWN`` rule checks against; default
``security-master/counterparties.csv``). Only that one object is read: the role has no
``s3:ListBucket`` and no need for the issuer half of the security master.
"""

import logging
import os

import boto3
from botocore.exceptions import ClientError

from backend.deal_pipeline.oms_schema import parse_csv
from backend.deal_pipeline.oms_validator import VALIDATOR_VERSION, validate
from backend.deal_pipeline.security_master import SecurityMaster
from backend.recon_core.ddb_update import (
    is_conditional_check_failed,
    update_attributes,
    utc_now_iso,
)

logger = logging.getLogger(__name__)

OMS_ACTOR = "mock-oms"
DEFAULT_COUNTERPARTIES_KEY = "security-master/counterparties.csv"


def validate_csv_text(text: str, counterparties) -> list[dict]:
    """Parse and validate CSV text; a file that cannot be read at all is one ``HEADER_MISMATCH``."""
    try:
        labels, fields = parse_csv(text)
    except ValueError as exc:
        return [
            {
                "code": "HEADER_MISMATCH",
                "field": None,
                "message": f"The file could not be read as a pipeline import: {exc}.",
                "hint": "A pipeline import is one header row of field labels followed by exactly "
                "one data row with the same number of cells.",
            }
        ]
    return validate(fields, labels, counterparties)


def handle(event, _context=None) -> dict:
    """Validate the deal named by ``event["deal_id"]`` and return its ``UploadResult``.

    The returned dict is the UploadResult of design section 4 plus ``deal_id`` and the deal's new
    ``status`` so the caller can refresh its view without a second read.

    :raises KeyError: when the deal does not exist (a caller error; nothing has been changed).
    """
    deal_id = event["deal_id"]
    deals = boto3.resource("dynamodb").Table(os.environ["DEALS_TABLE"])
    s3 = boto3.client("s3")
    bucket = os.environ["ASSETS_BUCKET"]

    deal = deals.get_item(Key={"deal_id": deal_id}).get("Item")
    if deal is None:
        raise KeyError(f"deal {deal_id} not found")
    csv_key = deal.get("csv_key") or f"deal-csv/{deal_id}.csv"
    body = s3.get_object(Bucket=bucket, Key=csv_key)["Body"].read().decode("utf-8")

    counterparties = SecurityMaster.counterparties_from_s3(
        s3, bucket, os.environ.get("COUNTERPARTIES_KEY", DEFAULT_COUNTERPARTIES_KEY)
    )
    errors = validate_csv_text(body, counterparties)
    attempted_at = utc_now_iso()
    accepted = not errors
    staging_key = f"oms-staging/{deal_id}.csv" if accepted else None

    result = {
        "attempted_at": attempted_at,
        "accepted": accepted,
        "staging_key": staging_key,
        "errors": errors,
        "validator_version": VALIDATOR_VERSION,
    }
    status = "UPLOADED" if accepted else "UPLOAD_FAILED"
    history_entry = {
        "at": attempted_at,
        "actor": OMS_ACTOR,
        "action": "UPLOAD_ACCEPTED" if accepted else "UPLOAD_REJECTED",
        "detail": (
            f"Copied to {staging_key}"
            if accepted
            else "Rejected: " + ", ".join(sorted({e["code"] for e in errors}))
        ),
    }
    # Only an APPROVED deal may become UPLOADED / UPLOAD_FAILED. A reviewer who rejected the deal
    # while this ran must win: the verdict is returned but not persisted, and nothing reaches
    # oms-staging/ for a deal the desk withdrew.
    try:
        update_attributes(
            deals,
            {"deal_id": deal_id},
            {"status": status, "upload": result, "updated_at": attempted_at},
            append={"history": [history_entry]},
            expect={"status": "APPROVED"},
        )
    except ClientError as err:
        if not is_conditional_check_failed(err):
            raise
        current = (deals.get_item(Key={"deal_id": deal_id}).get("Item") or {}).get("status")
        logger.warning(
            "deal %s is %s, not APPROVED; upload verdict %s not persisted", deal_id, current, status
        )
        return {**result, "deal_id": deal_id, "status": current, "persisted": False}

    if accepted:
        s3.put_object(
            Bucket=bucket, Key=staging_key, Body=body.encode("utf-8"), ContentType="text/csv"
        )
    logger.info("deal %s upload %s (%d errors)", deal_id, status, len(errors))
    return {**result, "deal_id": deal_id, "status": status, "persisted": True}
