"""General-ledger query tool: an AWS Lambda that invokes Athena over the GL data in S3.

Mocks a general ledger for the demo. Registered as the ``general-ledger`` tool on the
AgentCore Gateway (search_ledger) AND invoked directly by Tier-1 for the deterministic
auto-clear lookup. Input filters are validated/escaped and every query is LIMIT-bounded.
"""

import os
import time
from typing import Optional

import boto3


def _esc(s: str) -> str:
    """Escape a string literal for Athena SQL (single quotes doubled)."""
    return str(s).replace("'", "''")


def _num(v, name: str) -> float:
    """Validate a numeric filter; fail loudly on garbage (never interpolate raw input)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be numeric, got {v!r}")


def build_query(
    *,
    reference: Optional[str] = None,
    borrower: Optional[str] = None,
    facility: Optional[str] = None,
    min_amount=None,
    max_amount=None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 25,
) -> str:
    """Build a bounded, escaped SELECT over the GL table from the given filters.

    :returns: the Athena SQL string (LIMIT-capped; WHERE only when filters are present).
    """
    db = os.environ.get("GL_DATABASE", "recon_gl")
    table = os.environ.get("GL_TABLE", "gl_entries")
    where = []
    if reference:
        where.append(f"reference = '{_esc(reference)}'")
    if borrower:
        where.append(f"upper(borrower) LIKE '%{_esc(borrower).upper()}%'")
    if facility:
        where.append(f"upper(facility) LIKE '%{_esc(facility).upper()}%'")
    if min_amount is not None:
        where.append(f"amount >= {_num(min_amount, 'min_amount')}")
    if max_amount is not None:
        where.append(f"amount <= {_num(max_amount, 'max_amount')}")
    if date_from:
        where.append(f"value_date >= DATE '{_esc(date_from)}'")
    if date_to:
        where.append(f"value_date <= DATE '{_esc(date_to)}'")
    clause = f" WHERE {' AND '.join(where)}" if where else ""
    capped = max(1, min(int(limit or 25), 100))
    # Not user-controllable SQL injection: string filters are single-quote-escaped via _esc(),
    # numeric filters are float-validated via _num(), the identifiers ({db}/{table}) come from
    # fixed env vars (never request input), and the row count is int-capped to [1,100].
    return f'SELECT * FROM "{db}"."{table}"{clause} ORDER BY value_date LIMIT {capped}'  # nosec B608


def _rows_from_results(results: dict) -> list[dict]:
    """Convert Athena GetQueryResults (header row + data rows) into a list of dicts."""
    rows = results.get("ResultSet", {}).get("Rows", [])
    if not rows:
        return []
    header = [c.get("VarCharValue", "") for c in rows[0]["Data"]]
    out = []
    for r in rows[1:]:
        vals = [c.get("VarCharValue") for c in r["Data"]]
        out.append(dict(zip(header, vals)))
    return out


def _apply_status_overlay(rows: list[dict], *, ddb=None) -> list[dict]:
    """Merge the GL status overlay onto Athena rows so reads reflect prior writes.

    The authoritative GL is read-only; ``set_draw_status`` records mutations in the
    ``GL_STATUS_TABLE`` DynamoDB overlay keyed by ``reference``. When that table is configured,
    each row whose ``reference`` has an overlay entry gets ``status``/``reason``/``updated_at``
    merged in. No table configured (or no matching entry) → rows are returned unchanged.
    """
    table = os.environ.get("GL_STATUS_TABLE")
    if not table or not rows:
        return rows
    ddb = ddb or boto3.resource("dynamodb")
    tbl = ddb.Table(table)
    for row in rows:
        ref = row.get("reference")
        if not ref:
            continue
        item = tbl.get_item(Key={"reference": ref}).get("Item")
        if item:
            row["status"] = item.get("status")
            row["reason"] = item.get("reason")
            row["updated_at"] = item.get("updated_at")
    return rows


def handle(event, _context, *, athena=None, sleeper=time.sleep, ddb=None):
    """Run a GL query and return the matching entries (with any status overlay merged in).

    Event (tool input): {reference?, borrower?, facility?, min_amount?, max_amount?,
    date_from?, date_to?, limit?}. Returns {"rows": [...], "count": n}.

    :param athena: injectable Athena client (tests); real client by default.
    :param sleeper: injectable sleep for the poll loop (tests pass a no-op).
    :param ddb: injectable DynamoDB resource for the status overlay (tests).
    """
    athena = athena or boto3.client("athena")
    query = build_query(
        reference=event.get("reference"),
        borrower=event.get("borrower"),
        facility=event.get("facility"),
        min_amount=event.get("min_amount"),
        max_amount=event.get("max_amount"),
        date_from=event.get("date_from"),
        date_to=event.get("date_to"),
        limit=event.get("limit") or 25,
    )
    qid = athena.start_query_execution(
        QueryString=query,
        WorkGroup=os.environ.get("ATHENA_WORKGROUP", "primary"),
    )["QueryExecutionId"]
    # Poll to completion (Athena on a 10-row CSV returns in ~1-2s; cap ~25s under the timeout).
    for _ in range(50):
        state = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]["Status"][
            "State"
        ]
        if state == "SUCCEEDED":
            break
        if state in ("FAILED", "CANCELLED"):
            raise RuntimeError(f"Athena query {qid} {state}")
        sleeper(0.5)
    else:
        raise TimeoutError(f"Athena query {qid} did not finish")
    rows = _rows_from_results(athena.get_query_results(QueryExecutionId=qid))
    rows = _apply_status_overlay(rows, ddb=ddb)
    return {"rows": rows, "count": len(rows)}
