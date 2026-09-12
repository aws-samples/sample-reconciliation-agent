"""The inverted index over a notice's extracted fields: one posting per (field, value, notice).

Why this exists at all. A DynamoDB GSI key attribute holds ONE value per item, so a single GSI cannot
index twenty different fields of the same notice. That is the reason `recon-notices` indexes only
`counterparty`/`notice_date` and `reference`, and the reason those three are the only extracted field
names recon hardcodes anywhere (see ``PROMOTED_EXTRACTED_FIELDS`` in ``notices.py``). Putting the
postings in items of their own removes the constraint: the key attributes are names RECON owns, and the
extracted field's name is DATA inside one of them, so a field the pipeline starts emitting is indexed
without a schema change, a Terraform edit, or a rename hazard.

One item shape serves both query kinds, which is what lets the writer stay ignorant of how a field will
be searched::

    search_field = "cusip"           # the extractor's own key name
    search_value = "12345ab6#idp-Notice.pdf"

    equality -> search_field = "cusip"       AND begins_with(search_value, "12345ab6#")
    range    -> search_field = "notice_date" AND search_value BETWEEN "2026-01-01" AND "2026-01-31#<max>"

⚠️ Two encoding rules make those queries correct, and both are decided from the VALUE rather than from
the field's name -- a name-based rule would be exactly the hardcoding this module exists to avoid:

* text is casefolded, because equality matching is case-insensitive everywhere else in this platform
  (``_matches`` in ``backend/notice_tool/handler.py`` lowercases both sides);
* numbers are written in a fixed-width, offset form so that lexical order IS numeric order. Naive
  zero-padding is not enough: an amount can be negative (a credit), and ``"-500.00"`` sorts below
  ``"1000.00"`` as text while being greater as a number. See :func:`_encode`.

The original value is kept in a non-key attribute so a reader never has to invert the encoding.
"""

from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Iterator


# The character that separates an encoded value from the notice id inside the sort key.
#
# `begins_with(escaped_value + SEP)` is what makes an equality probe EXACT rather than a prefix match
# that also catches longer values -- without it, searching for `"12"` would also return a notice whose
# value was `"123"`.
SEP = "#"

# The partition holding one posting per notice, used to compute "notices that do NOT carry field X" as
# `all_notice_ids() - notice_ids_with_field(X)`. That complement is what lets `search_notices` keep a
# filter SOFT -- a notice missing the field is annotated rather than excluded -- without naming a single
# extracted field in code. A posting list alone cannot express absence; this partition is its complement.
#
# Far cheaper than the Scan it replaces: a posting is ~100 bytes against a ~5.7 KB notice row.
ALL_FIELD = "#all"

# `#` prefixes recon's own reserved partitions. Extracted field names come from the extraction
# configuration, so collision is prevented by REJECTING such a name rather than by hoping none appears --
# a field called `#all` would otherwise silently merge its postings into the all-notices set and make
# every notice look like it matched everything.
RESERVED_PREFIX = "#"

# ⚠️ The separator has to be ESCAPED out of the encoded value, or a value that itself contains one
# breaks that exactness: `"WIRE#001"` and `"WIRE"` would encode to `wire#001#n1` and `wire#n2`, and a
# probe for `"WIRE"` (`begins_with("wire#")`) would match both. `#` occurs in real extracted references,
# so this is a live case and not a theoretical one.
#
# Escape the escape character FIRST, or the mapping is not injective.
_ESC = "~"
_ESCAPES = ((_ESC, _ESC + "0"), (SEP, _ESC + "1"))

# Sorts above every code point, so a closed upper bound covers `<value>#<any notice id>`. A bare
# `BETWEEN lo AND hi` would stop at `hi` itself and miss every posting sitting on it.
_MAX_CHAR = chr(0x10FFFF)


def _escape(encoded: str) -> str:
    """Remove the separator from an encoded value so it cannot terminate the key early.

    A no-op on the numeric encoding, which is pure digits — so numeric ordering is untouched by this.

    :param encoded: the output of :func:`_encode`.
    :returns: the escaped form, guaranteed to contain no :data:`SEP`.
    """
    for char, replacement in _ESCAPES:
        encoded = encoded.replace(char, replacement)
    return encoded


# Fixed-width numeric encoding. Every number becomes exactly `_INT_DIGITS + _FRAC_DIGITS` digits, with
# `_OFFSET` added first so negatives are non-negative and still sort correctly. The width has to be
# fixed for lexical order to be numeric order -- `"9"` sorts above `"10"` otherwise.
_INT_DIGITS = 18
_FRAC_DIGITS = 6
_OFFSET = Decimal(10) ** _INT_DIGITS
_SCALE = Decimal(10) ** _FRAC_DIGITS
_TOTAL_DIGITS = _INT_DIGITS + 1 + _FRAC_DIGITS


def _encode(value: Any) -> str | None:
    """Encode one extracted value into a sortable, matchable sort-key prefix.

    Numeric where the value parses as a number, casefolded text otherwise. The choice is made from the
    VALUE, never from the field's name, so the encoding needs no knowledge of the extraction schema.

    :param value: the extracted value, typically the string the extractor emitted.
    :returns: the encoded prefix, or None when the value carries no information to index (None, or a
        string that is blank once stripped). None means "write no posting": a posting for an absent
        value would make the field look extracted, and absence is what the agent reads as
        ``fields_unavailable``.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = Decimal(text)
    except InvalidOperation:
        return text.casefold()
    # A value the extractor emitted that is numeric but absurd (an id misread as a number, say) still
    # encodes -- it is real extracted content and the caller asked to index what was extracted. Only a
    # magnitude that will not FIT the fixed width falls back to text, because a truncated number would
    # sort into the wrong place and silently answer range queries wrongly.
    shifted = (number * _SCALE).to_integral_value() + (_OFFSET * _SCALE)
    if shifted < 0 or len(str(shifted)) > _TOTAL_DIGITS:
        return text.casefold()
    return str(shifted).rjust(_TOTAL_DIGITS, "0")


def encode_probe(value: str) -> str:
    """Encode a caller's search term the same way a stored posting was encoded.

    Separate from :func:`_encode` only in that a caller's term is never absent -- reaching here with a
    blank one is the caller's bug, and it returns a blank probe that matches nothing rather than a
    probe that matches everything.

    :param value: the search term as the caller supplied it.
    :returns: the encoded and escaped term, ready to have :data:`SEP` appended for a ``begins_with``.
    """
    encoded = _encode(value)
    return _escape(encoded) if encoded is not None else ""


def posting_key(*, field: str, value: Any, notice_id: str) -> dict[str, str] | None:
    """The primary key of one posting, or None when the value is not worth indexing.

    :param field: the extracted field's own name, verbatim from the extraction.
    :param value: the extracted value.
    :param notice_id: the notice the posting points at.
    :returns: ``{"search_field": ..., "search_value": ...}``, or None.
    """
    encoded = _encode(value)
    if encoded is None:
        return None
    return {"search_field": field, "search_value": f"{_escape(encoded)}{SEP}{notice_id}"}


def postings_for(*, notice_id: str, fields: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Every posting one notice contributes, one per indexable extracted field.

    :param notice_id: the notice the postings point at.
    :param fields: the notice's extracted fields, flattened -- field name to value.
    :yields: the full item to write, key attributes plus ``notice_id`` and the un-encoded ``raw_value``.
    """
    # The all-notices posting, written for every notice regardless of what it extracted. Its absence is
    # not a degraded index but a WRONG one: `all - present(X)` would under-report the notices lacking X,
    # so a soft filter would silently exclude rows it is required to annotate.
    yield {"search_field": ALL_FIELD, "search_value": notice_id, "notice_id": notice_id}
    for field, value in fields.items():
        if field.startswith(RESERVED_PREFIX):
            raise ValueError(
                f"extracted field {field!r} starts with the reserved prefix {RESERVED_PREFIX!r}; "
                "recon uses that prefix for its own index partitions and cannot store this field"
            )
        key = posting_key(field=field, value=value, notice_id=notice_id)
        if key is None:
            continue
        # `raw_value` is carried so a reader can display what the document said without inverting the
        # encoding, which is lossy for text (casefolded) and for numbers (fixed precision).
        yield {**key, "notice_id": notice_id, "raw_value": str(value)}


def flatten_sections(sections: Any) -> dict[str, Any]:
    """Flatten a notice's embedded sections into one field map, first section winning.

    Mirrors ``_extracted_fields`` in ``backend/notice_tool/handler.py``. Duplicated deliberately: that
    module must not import a writer, and this one must not import a reader, so the shared alternative
    would be a third module holding four lines. The precedence matches ``idp_event_to_notice``, which
    derives a notice's own scalars from ``sections[0]``.

    :param sections: the notice's ``idp_sections`` value.
    :returns: field name to value, empty when there are no usable sections.
    """
    out: dict[str, Any] = {}
    if not isinstance(sections, list):
        return out
    for section in sections:
        if not isinstance(section, dict):
            continue
        fields = section.get("fields")
        if isinstance(fields, dict):
            for name, value in fields.items():
                out.setdefault(name, value)
    return out


def indexable_fields(row: Any) -> dict[str, Any]:
    """Everything about a notice that should be searchable.

    Exactly its embedded extraction, because that is now the only place extracted content lives. This
    used to layer three promoted attributes on top -- `counterparty`, `notice_date`, `reference` -- which
    held values the raw extraction did not: the mapper resolved `borrower`, folded `value_date` into
    `notice_date`, and defaulted a missing obligor to `"unknown"`. Those attributes and that normalisation
    are gone with the GSIs that required them, so there is nothing left to layer.

    Kept as a named function rather than collapsed into :func:`flatten_sections` at every call site: it is
    the ONE place that decides what gets indexed, and both writers (the hook and the backfill) go through
    it, so they cannot drift into indexing different things.

    :param row: a notice as a mapping -- a stored DynamoDB item or a dumped model.
    :returns: field name to value, ready for :meth:`NoticeSearchIndex.reindex`.
    """
    return flatten_sections(row.get("idp_sections"))


# BatchWriteItem's hard ceiling on requests per call.
_BATCH_LIMIT = 25


def _chunk(items: list, size: int) -> Iterable[list]:
    """Split a list into fixed-size chunks.

    :param items: the list to split.
    :param size: the maximum chunk length.
    :yields: each chunk.
    """
    for start in range(0, len(items), size):
        yield items[start : start + size]


class NoticeSearchIndex:
    """Writes and reads the postings for one deployment's notice search index."""

    def __init__(self, *, table_name: str, ddb: Any = None) -> None:
        """Bind to a table.

        :param table_name: the search index table's name.
        :param ddb: an injectable boto3 Table stand-in; the real table is resolved when None.
        :returns: None.
        """
        self._table_name = table_name
        self._table = ddb
        if self._table is None:
            import boto3

            self._table = boto3.resource("dynamodb").Table(table_name)

    def existing_keys(self, *, notice_id: str, fields: Iterable[str]) -> list[dict[str, str]]:
        """Find the postings a notice already has, so a re-extraction can delete them.

        Queried per FIELD rather than scanned, because a posting's partition is its field name and
        there is no index from notice_id back to its postings. `fields` therefore has to be the union
        of what the notice used to carry and what it carries now -- a field dropped by a re-extraction
        is the whole reason this exists, and only the caller knows both sets.

        :param notice_id: the notice whose postings to find.
        :param fields: field names to look under.
        :returns: the primary keys of the postings found.
        """
        found: list[dict[str, str]] = []
        for field in set(fields):
            kwargs: dict[str, Any] = {
                "KeyConditionExpression": "search_field = :f",
                "FilterExpression": "notice_id = :n",
                "ExpressionAttributeValues": {":f": field, ":n": notice_id},
                "ProjectionExpression": "search_field, search_value",
            }
            while True:
                resp = self._table.query(**kwargs)
                found.extend(
                    {"search_field": i["search_field"], "search_value": i["search_value"]}
                    for i in resp.get("Items", [])
                )
                token = resp.get("LastEvaluatedKey")
                if not token:
                    break
                kwargs["ExclusiveStartKey"] = token
        return found

    def reindex(
        self, *, notice_id: str, fields: dict[str, Any], previous: Iterable[str] = ()
    ) -> int:
        """Replace a notice's postings with the ones its current fields imply.

        Delete-then-write rather than write-only. The index is keyed on (field, value), so a notice
        whose counterparty was corrected by a re-extraction would otherwise stay findable under the old
        value forever -- a stale posting is worse than a missing one, because it returns a notice that
        does not say what the search claimed.

        :param notice_id: the notice being indexed.
        :param fields: its extracted fields, flattened.
        :param previous: field names the notice may have carried before, in addition to the current
            ones. Pass the old extraction's keys when they are known.
        :returns: the number of postings written.
        """
        wanted = list(postings_for(notice_id=notice_id, fields=fields))
        wanted_keys = {(w["search_field"], w["search_value"]) for w in wanted}
        stale = [
            key
            for key in self.existing_keys(notice_id=notice_id, fields=set(fields) | set(previous))
            if (key["search_field"], key["search_value"]) not in wanted_keys
        ]

        for chunk in _chunk(stale, _BATCH_LIMIT):
            self._write_batch([{"DeleteRequest": {"Key": key}} for key in chunk])
        for chunk in _chunk(wanted, _BATCH_LIMIT):
            self._write_batch([{"PutRequest": {"Item": item}} for item in chunk])
        return len(wanted)

    def _write_batch(self, requests: list[dict]) -> None:
        """Send one BatchWriteItem, retrying whatever DynamoDB leaves unprocessed.

        :param requests: up to 25 Put/Delete requests.
        :returns: None.
        :raises RuntimeError: when requests remain unprocessed after the retries. Reported rather than
            dropped: a silently skipped posting makes a notice unfindable under a field it carries,
            which reads exactly like a notice that does not carry it.
        """
        pending = requests
        for _attempt in range(3):
            if not pending:
                return
            resp = self._table.meta.client.batch_write_item(
                RequestItems={self._table_name: pending}
            )
            pending = resp.get("UnprocessedItems", {}).get(self._table_name, [])
        if pending:
            raise RuntimeError(
                f"{len(pending)} search-index write(s) still unprocessed after 3 attempts on "
                f"{self._table_name}; the index is now incomplete for this notice"
            )

    def notice_ids_with_field(self, *, field: str) -> set[str]:
        """Every notice that carries a value for one field, whatever that value is.

        The whole partition, with no value condition -- a posting exists if and only if the notice
        carried something for that field. Paired with :meth:`all_notice_ids` this yields the notices
        LACKING the field, which is the half a posting list cannot express and the reason
        `search_notices` can keep a filter soft without naming any field in code.

        :param field: the extracted field's name.
        :returns: the notice ids carrying it. Empty means no notice does.
        """
        return self._ids_in_partition(field)

    def all_notice_ids(self) -> set[str]:
        """Every notice the index knows about.

        :returns: the notice ids. Empty means the index is empty -- which for a non-empty notices table
            means the index was never built, and the caller must not read that as "nothing matches".
        """
        return self._ids_in_partition(ALL_FIELD)

    def _ids_in_partition(self, field: str) -> set[str]:
        """Read every notice id in one partition, following pagination.

        :param field: the partition's `search_field`.
        :returns: the notice ids.
        """
        out: set[str] = set()
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "search_field = :f",
            "ExpressionAttributeValues": {":f": field},
            "ProjectionExpression": "notice_id",
        }
        while True:
            resp = self._table.query(**kwargs)
            out.update(i["notice_id"] for i in resp.get("Items", []) if "notice_id" in i)
            token = resp.get("LastEvaluatedKey")
            if not token:
                break
            kwargs["ExclusiveStartKey"] = token
        return out

    def notice_ids_for(
        self,
        *,
        field: str,
        equals: str | None = None,
        low: str | None = None,
        high: str | None = None,
    ) -> set[str]:
        """The notices whose posting for one field satisfies one condition.

        :param field: the extracted field's name.
        :param equals: exact value to match, encoded the same way the posting was.
        :param low: inclusive lower bound for a range query.
        :param high: inclusive upper bound for a range query.
        :returns: the matching notice ids. Empty means "queried, nothing matched".
        :raises ValueError: when neither an equality nor a bound is given -- an unconstrained query
            would return the whole partition and read as a successful broad match.
        """
        if equals is None and low is None and high is None:
            raise ValueError(f"search on {field!r} needs an equality or a bound")

        values: dict[str, Any] = {":f": field}
        if equals is not None:
            condition = "search_field = :f AND begins_with(search_value, :v)"
            values[":v"] = f"{encode_probe(equals)}{SEP}"
        else:
            condition = "search_field = :f AND search_value BETWEEN :lo AND :hi"
            # An open-ended bound becomes the extreme of the encoding's own range rather than being
            # dropped: dropping it would widen the query to the whole partition.
            # ⚠️ Ranges are only correct over a FIXED-WIDTH encoding -- the numeric form, and ISO dates,
            # where no value is a prefix of another. On free text a shorter value sorts inside a longer
            # one's span, so a text range would over-include. Nothing asks for one; do not add it here
            # without changing the encoding to be prefix-free.
            values[":lo"] = encode_probe(low) if low is not None else ""
            values[":hi"] = (
                f"{encode_probe(high)}{SEP}{_MAX_CHAR}" if high is not None else _MAX_CHAR
            )

        out: set[str] = set()
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": condition,
            "ExpressionAttributeValues": values,
            "ProjectionExpression": "notice_id",
        }
        while True:
            resp = self._table.query(**kwargs)
            out.update(i["notice_id"] for i in resp.get("Items", []) if "notice_id" in i)
            token = resp.get("LastEvaluatedKey")
            if not token:
                break
            kwargs["ExclusiveStartKey"] = token
        return out
