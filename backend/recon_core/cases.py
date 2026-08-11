"""DynamoDB-backed case store and audit log for the reconciliation flow.

Holds only recon-flow state: the case row (status + proposal fields) keyed by item_id, and
an append-only audit row per state change. All numeric fields are stored as ``Decimal`` (boto3
rejects Python floats). Status transitions are guarded by the state machine and written
conditionally so concurrent stream deliveries cannot double-advance a case.

Two invariants this module enforces:

* **``open()`` is the only method that may create a case row.** Every other write is conditional
  on ``attribute_exists(item_id)``, because a bare DynamoDB ``update_item`` is an UPSERT: writing
  a proposal or a status onto an item that has no case row produced a row with no ``status`` and
  no ``created_at``, which is absent from the status-index GSI (so invisible to the UI queue)
  and makes every later ``status()`` call raise ``KeyError``. Observed live on two
  synthetic items. A missing case now fails loudly at the write instead.
* **An audit row is never overwritten.** ``ts`` is the audit table's RANGE key, so two rows
  written in the same instant for one item would collide and the second would silently replace
  the first — data loss in an append-only compliance trail.
"""

import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from backend.recon_core.schema import ReconItem
from backend.recon_core.status import CaseStatus, can_transition

# How many microsecond bumps to try when an audit ts collides with an existing row.
_AUDIT_TS_ATTEMPTS = 10


class CaseStore:
    """Accessor for the recon-cases and recon-audit DynamoDB tables."""

    def __init__(self, table: str, audit: str):
        """Bind to the cases and audit tables via the default boto3 session."""
        ddb = boto3.resource("dynamodb")
        self._cases = ddb.Table(table)
        self._audit = ddb.Table(audit)

    def _now(self) -> str:
        """Return an ISO-ish UTC timestamp string for created_at / audit ts ordering."""
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())

    def _update_existing(self, *, item_id: str, **update_kwargs) -> None:
        """``update_item`` that refuses to CREATE the case row (see the module invariants).

        :param item_id: the case key.
        :param update_kwargs: the rest of the ``update_item`` arguments (UpdateExpression,
            ExpressionAttributeNames/Values, …).
        :returns: None
        :raises KeyError: when no case row exists for ``item_id``.
        """
        try:
            self._cases.update_item(
                Key={"item_id": item_id},
                ConditionExpression="attribute_exists(item_id)",
                **update_kwargs,
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise KeyError(
                    f"case {item_id} not found — refusing to create a partial case row"
                ) from exc
            raise

    def _audit_row(self, item_id: str, status: CaseStatus, note: str) -> None:
        """Append an audit row recording a state change, never overwriting an existing one.

        ``ts`` is microsecond-resolution UTC so rows sort correctly as strings: the previous
        second-resolution stamp plus a ``perf_counter_ns()`` suffix sorted arbitrarily within a
        second, because that counter is per-process (unrelated origins across Lambdas) and
        variable-width (``"9"`` sorts after ``"20593…"``), and it is not a real sub-second value.
        On the rare exact-microsecond collision the stamp is bumped by 1µs and retried, so an
        append-only row is never silently replaced.

        :param item_id: the case key.
        :param status: the status this row records.
        :param note: human-readable description of the change.
        :returns: None
        :raises RuntimeError: when no free ts is found, rather than dropping the audit row.
        """
        base = datetime.now(timezone.utc)
        for attempt in range(_AUDIT_TS_ATTEMPTS):
            stamp = base + timedelta(microseconds=attempt)
            try:
                self._audit.put_item(
                    Item={
                        "item_id": item_id,
                        "ts": stamp.strftime("%Y-%m-%dT%H:%M:%S.%f"),
                        "status": status.value,
                        "note": note,
                    },
                    ConditionExpression="attribute_not_exists(ts)",
                )
                return
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
        raise RuntimeError(
            f"could not write an audit row for {item_id}: "
            f"{_AUDIT_TS_ATTEMPTS} consecutive timestamps were already taken"
        )

    def open(
        self,
        item: ReconItem,
        *,
        status: CaseStatus,
        tier: int,
        category: str | None = None,
    ) -> bool:
        """Create a case row for an item, conditionally (idempotent).

        Returns True if the case was newly created, False if a case already existed for the
        item (a redelivered stream record). The row carries item_id, status, created_at
        (RANGE key of the status-index GSI), tier, and optional deterministic category.
        """
        item_dict = item.model_dump()
        row = {
            "item_id": item.item_id,
            "status": status.value,
            "created_at": self._now(),
            "tier": tier,
            "domain": item.domain,
            "item": item_dict,
        }
        if category is not None:
            row["category"] = category
        try:
            self._cases.put_item(
                Item=row, ConditionExpression="attribute_not_exists(item_id)"
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        self._audit_row(item.item_id, status, f"case opened at tier {tier}")
        return True

    def status(self, item_id: str) -> CaseStatus:
        """Return the current status of a case."""
        resp = self._cases.get_item(Key={"item_id": item_id})
        if "Item" not in resp:
            raise KeyError(f"case {item_id} not found")
        return CaseStatus(resp["Item"]["status"])

    def get(self, item_id: str) -> dict:
        """Return the full case row (incl. proposal fields) as a plain dict."""
        resp = self._cases.get_item(Key={"item_id": item_id})
        if "Item" not in resp:
            raise KeyError(f"case {item_id} not found")
        return resp["Item"]

    def set_status(self, item_id: str, new_status: CaseStatus, *, note: str | None = None) -> None:
        """Set a case status without the state-machine check (caller has already checked
        can_transition), but only on an existing case row.

        :param item_id: the case key.
        :param new_status: the status to write.
        :param note: optional audit annotation (e.g. the acting principal + comment); falls
            back to the generic "status set".
        :raises KeyError: when no case row exists for ``item_id``.
        """
        self._update_existing(
            item_id=item_id,
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": new_status.value},
        )
        self._audit_row(item_id, new_status, note or "status set")

    def transition(
        self, key_name: str, key: str, new_status: CaseStatus, *, note: str | None = None
    ) -> bool:
        """Guarded transition: advance only if the current status allows it.

        Uses a conditional update on the expected current status so two concurrent stream
        deliveries cannot both advance the case. Returns True if this call performed the
        transition, False if the transition was not allowed or lost the race.

        :param key_name: the table's key attribute name (``item_id``).
        :param key: the case key value.
        :param new_status: the target status.
        :param note: optional audit annotation appended to the transition record (e.g. the
            acting principal + comment).
        """
        current = self.status(key)
        if not can_transition(current, new_status):
            return False
        try:
            self._cases.update_item(
                Key={key_name: key},
                UpdateExpression="SET #s = :new",
                ConditionExpression="#s = :cur",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":new": new_status.value, ":cur": current.value},
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        base = f"transition {current.value}->{new_status.value}"
        self._audit_row(key, new_status, f"{base} — {note}" if note else base)
        return True

    def attach_proposal(
        self,
        *,
        item_id: str,
        class_id: str,
        classification_confidence: Decimal,
        classification_reasoning: str,
        resolution: str,
        confidence: Decimal,
        steps: list[dict],
        confidence_components: dict | None = None,
        proposed_action: dict | None = None,
        proposed_email: dict | None = None,
    ) -> None:
        """Write the agent's proposal (classification + typed trace) onto the case.

        ``confidence_components`` is the transparency breakdown of the computed composite
        confidence (consistency / grounding / verbalized), shown on the case detail.
        ``steps`` are opaque dicts (any typed-trace fields the caller includes are stored
        verbatim). ``proposed_action`` is the structured, executable action derived from the
        investigation (``None`` when nothing is safely actionable) — persisted so the
        human-approve path can execute it later.

        ``proposed_email`` is the counterparty email draft awaiting human approval, or ``None``
        when no outbound contact is needed. Persisted for the same reason as ``proposed_action``:
        the send is executed later by platform code, and the gateway interceptor matches the
        outgoing message against this row so a send can only carry text a human approved. It stays
        a separate attribute — see ``schema.Proposal.proposed_email`` for why it is not folded into
        ``proposed_action``.

        :raises KeyError: when no case row exists for ``item_id``. ``open()`` runs first in every
            real flow; without this guard a proposal written for an unknown item created a
            statusless orphan row (see the module invariants).
        """
        self._update_existing(
            item_id=item_id,
            UpdateExpression=(
                "SET class_id = :c, classification_confidence = :cc, "
                "classification_reasoning = :cr, resolution = :r, confidence = :conf, "
                "steps = :st, confidence_components = :comp, proposed_action = :pa, "
                "proposed_email = :pe"
            ),
            ExpressionAttributeValues={
                ":c": class_id,
                ":cc": classification_confidence,
                ":cr": classification_reasoning,
                ":r": resolution,
                ":conf": confidence,
                ":st": steps,
                ":comp": confidence_components or {},
                ":pa": proposed_action,
                ":pe": proposed_email,
            },
        )

    # Terminal statuses a case can reach; a fresh IDP reprocess re-opens even these.
    _TERMINAL = (
        CaseStatus.RESOLVED,
        CaseStatus.AUTO_CLEARED,
        CaseStatus.CLOSED_NO_ACTION,
        CaseStatus.AGED,
    )

    def redrive(self, item: ReconItem, *, reprocess_cap: int) -> str:
        """Re-drive a case after a genuine IDP reprocess (a NEW extraction of the same document).

        Refreshes the case's embedded item snapshot with the freshly-mapped item, bumps the
        reprocess counter, and resets the case to PENDING so the agent re-investigates — even
        from a terminal state (RESOLVED/AUTO_CLEARED/CLOSED_NO_ACTION/AGED), which a normal
        ``transition`` forbids. Reset-to-PENDING skips the state machine here (this path is only
        reachable from the IDP hook on a confirmed rerun) but still requires the case row to
        exist, with an audit note recording the prior status; ``can_transition`` is intentionally
        left unchanged.

        :param item: the freshly-mapped ReconItem (new idp_* attributes + execution arn).
        :param reprocess_cap: max reprocess attempts; at the cap the case ages out (-> AGED)
            instead of re-driving, mirroring the reject->reprocess cap.
        :returns: ``"redriven"`` (reset to PENDING) or ``"aged"`` (cap reached).
        """
        existing = self.get(item.item_id)
        prior = existing["status"]
        stored_item = existing.get("item", {}) or {}
        attrs = dict(stored_item.get("attributes", {}) or {})
        # Carry forward the reprocess counter across IDP-driven and UI-driven re-drives.
        count = int(attrs.get("reprocess_count", 0)) + 1

        # Refresh the snapshot with the NEW extraction, but preserve the running counter.
        new_item = item.model_dump()
        new_attrs = dict(new_item.get("attributes", {}) or {})
        new_attrs["reprocess_count"] = count
        new_item["attributes"] = new_attrs

        if count > reprocess_cap:
            self._update_existing(
                item_id=item.item_id,
                UpdateExpression="SET #s = :s, #it = :it",
                ExpressionAttributeNames={"#s": "status", "#it": "item"},
                ExpressionAttributeValues={":s": CaseStatus.AGED.value, ":it": new_item},
            )
            self._audit_row(
                item.item_id, CaseStatus.AGED, f"IDP reprocess cap reached ({count} > {reprocess_cap})"
            )
            return "aged"

        self._update_existing(
            item_id=item.item_id,
            UpdateExpression="SET #s = :s, #it = :it",
            ExpressionAttributeNames={"#s": "status", "#it": "item"},
            ExpressionAttributeValues={":s": CaseStatus.PENDING.value, ":it": new_item},
        )
        self._audit_row(
            item.item_id,
            CaseStatus.PENDING,
            f"IDP reprocess re-drive (was {prior}, reprocess #{count})",
        )
        return "redriven"
