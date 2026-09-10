"""DynamoDB-backed case store and audit log for the reconciliation flow.

Holds only recon-flow state: the case row (status + proposal fields) keyed by item_id, and
an append-only audit row per state change. All numeric fields are stored as ``Decimal`` (boto3
rejects Python floats). Status transitions are guarded by the state machine and written
conditionally so concurrent stream deliveries cannot double-advance a case.

Two invariants this module enforces:

* **``open()`` is the only method that may create a case row.** Every other write is conditional
  on ``attribute_exists(item_id)``, because a bare DynamoDB ``update_item`` is an UPSERT: writing
  a proposal or a status onto an item that has no case row creates a row with no ``status`` and
  no ``created_at``, which is absent from the status-index GSI (so invisible to the UI queue)
  and makes every later ``status()`` call raise ``KeyError``. The condition makes a missing case
  fail loudly at the write instead.
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
        tier1_match: dict | None = None,
    ) -> bool:
        """Create a case row for an item, conditionally (idempotent).

        Returns True if the case was newly created, False if a case already existed for the
        item (a redelivered stream record). The row carries item_id, status, created_at
        (RANGE key of the status-index GSI), tier, and optional deterministic category.

        :param item: the reconciliation item the case is opened for.
        :param status: the case status to open in.
        :param tier: the tier that produced this case, 1 for a deterministic clear and 2 for an
            escalation.
        :param category: the deterministic auto-clear category, or None for an escalation.
        :param tier1_match: the comparison Tier-1 performed to clear the item, or None. Written as a
            top-level attribute rather than folded into ``item``: that bag is the item as it arrived,
            and this is an output Tier-1 produced about it. Absent entirely when None, so an escalated
            case carries no empty placeholder for it. Its values
            are strings, including the amounts, both because boto3 rejects Python floats and because
            a Decimal round-trip through the BFF's JSON hop is lossy.
        :returns: True when the case was newly created, False when one already existed.
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
        if tier1_match is not None:
            row["tier1_match"] = tier1_match
        try:
            self._cases.put_item(Item=row, ConditionExpression="attribute_not_exists(item_id)")
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

    # Longest failure reason persisted onto the case. Reasons come from exception text, which can be
    # a multi-kilobyte boto3 error body or traceback; the case row is read on every queue render, so
    # an unbounded string would bloat every list response for no analyst benefit. Truncation is
    # explicit and marked in the stored value — the full text stays in the worker's CloudWatch log.
    _FAILURE_REASON_MAX = 800

    def mark_failed(self, item_id: str, *, reason: str) -> bool:
        """Escalate a case to FAILED after its investigation errored out.

        Writes the status, the (truncated) reason and the failure timestamp in ONE conditional
        update: two writes would leave a window where the case reads FAILED with no reason, which is
        exactly the state the analyst needs. The update is conditional on the case still being
        IN_PROGRESS, so a run that actually persisted its proposal just before erroring on the way
        out is never overwritten with a failure — the proposal wins.

        :param item_id: the case key.
        :param reason: human-readable cause (exception text); truncated to
            ``_FAILURE_REASON_MAX`` characters.
        :returns: True if this call marked the case FAILED; False if the transition was not allowed
            from the current status or lost the race with a concurrent write.
        :raises KeyError: when no case row exists for ``item_id``.
        """
        current = self.status(item_id)
        if not can_transition(current, CaseStatus.FAILED):
            return False
        text = reason.strip() or "investigation failed with no error text"
        if len(text) > self._FAILURE_REASON_MAX:
            text = text[: self._FAILURE_REASON_MAX] + "… (truncated, see worker logs)"
        try:
            self._cases.update_item(
                Key={"item_id": item_id},
                UpdateExpression="SET #s = :new, failure_reason = :fr, failed_at = :fa",
                ConditionExpression="#s = :cur",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":new": CaseStatus.FAILED.value,
                    ":cur": current.value,
                    ":fr": text,
                    ":fa": self._now(),
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        self._audit_row(item_id, CaseStatus.FAILED, f"investigation failed: {text}")
        return True

    def attach_proposal(
        self,
        *,
        item_id: str,
        class_id: str,
        classification_reasoning: str,
        resolution: str,
        confidence: Decimal,
        steps: list[dict],
        confidence_components: dict | None = None,
        proposed_action: dict | None = None,
        proposed_email: dict | None = None,
        # REQUIRED (no default) even though None is a legal value. Both agent backends call this, and
        # while it had a default the runtime backend silently wrote NULL here for a day — the panel
        # reported "cannot be shown" on every case the runtime investigated. Omitting it now raises.
        notice_search: dict | None,
        # REQUIRED for exactly the reason above, and pre-emptively rather than after the incident:
        # the second caller lives OUTSIDE this tree (``agent-blueprint/recon-agent/agent.py``), so a
        # change reviewed by grepping ``backend/`` reaches one backend and leaves the other writing
        # NULL. A default is what makes that omission silent; there is none.
        token_usage: dict | None,
    ) -> None:
        """Write the agent's proposal (classification + typed trace) onto the case.

        ``confidence_components`` is the breakdown of the computed evidence-completeness score —
        which of the classified skill's prescribed steps obtained data — shown on the case detail.
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

        ``notice_search`` is the FULL result set of the investigation's ``search_notices`` calls,
        persisted for the case's Matched Notices panel. It is stored rather than derived from
        ``steps`` at read time because the trace's ``tool_output`` is a 600-character display summary
        and one notice row exceeds it — the UI reading that fragment reported "matched no notices" on
        cases that had matched several. See ``recon_core.proposal_service.notice_search_summary``,
        which is where BOTH backends derive it. Required rather than defaulted — see the note at the
        parameter itself.

        ``token_usage`` is what the run cost in tokens plus the provenance needed to price it
        (``{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model_id,
        backend}``), as built by ``recon_core.token_usage.summarize_token_usage`` — the ONE mapper
        both backends import. Its counts must already be ``Decimal`` and its cache keys are absent
        when the provider reported none; this method stores the dict verbatim and coerces nothing, so
        a float that bypassed the mapper fails the write loudly instead of being rounded into the
        record. ``None`` is a legal value and means "nobody measured this run" — never zeros.

        :raises KeyError: when no case row exists for ``item_id``. ``open()`` runs first in every
            real flow; without this guard a proposal written for an unknown item created a
            statusless orphan row (see the module invariants).
        """
        self._update_existing(
            item_id=item_id,
            UpdateExpression=(
                # The only confidence written here is `confidence` — the computed
                # evidence-completeness score. There is deliberately no self-reported,
                # per-classification one anywhere in the system: one confidence signal, computed from
                # the trace, so a model cannot report its way past a gate. Enforced by
                # tests/recon_core/test_single_confidence_signal.py, which bans that attribute name
                # from this tree — hence describing it here rather than naming it.
                "SET class_id = :c, "
                "classification_reasoning = :cr, resolution = :r, confidence = :conf, "
                "steps = :st, confidence_components = :comp, proposed_action = :pa, "
                "proposed_email = :pe, notice_search = :ns, token_usage = :tu"
            ),
            ExpressionAttributeValues={
                ":c": class_id,
                ":cr": classification_reasoning,
                ":r": resolution,
                ":conf": confidence,
                ":st": steps,
                ":comp": confidence_components or {},
                ":pa": proposed_action,
                ":pe": proposed_email,
                ":ns": notice_search,
                ":tu": token_usage,
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
                item.item_id,
                CaseStatus.AGED,
                f"IDP reprocess cap reached ({count} > {reprocess_cap})",
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
