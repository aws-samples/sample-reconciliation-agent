"""Fictional security-master reference data: issuers to enrich from, counterparties to validate against.

Two CSVs, seeded from ``data/security-master`` into ``s3://<assets>/security-master/``:

- ``issuers.csv``: ``issuer_name, aliases, ticker, region, industry, sponsors, liquidity_score,
  asset_id`` -- what the parsing agent's ``lookup_security_master`` tool returns.
- ``counterparties.csv``: ``canonical_name, aliases`` -- the arranger names the OMS accepts. The
  OMS accepts ONLY the canonical spelling; aliases exist so the validator can say which canonical
  name an email's spelling was closest to.

Aliases are ``;``-separated inside one CSV cell. The loader takes CSV text, so tests and the
Lambda share one parser whether the bytes came from S3 or the repo's ``data/`` directory.
"""

import csv
import difflib
import io
import logging
import re
from pathlib import Path

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

ISSUERS_FILE = "issuers.csv"
COUNTERPARTIES_FILE = "counterparties.csv"

# GetObject on a key that does not exist is 404 NoSuchKey only when the caller may ListBucket;
# a role granted GetObject alone (the OMS upload role) gets 403 AccessDenied for the very same
# missing key. Both mean "nothing to load here".
_MISSING_OBJECT_CODES = {"NoSuchKey", "NoSuchBucket", "404", "NotFound", "AccessDenied", "403"}

# Fields the parsing agent copies from a matched issuer row onto the deal (schema key -> CSV column).
ISSUER_FIELD_MAP = {
    "region": "region",
    "industry": "industry",
    "sponsors": "sponsors",
    "asset": "asset_id",
    "liquidity_score": "liquidity_score",
}


def _split_aliases(cell: str | None) -> list[str]:
    return [a.strip() for a in (cell or "").split(";") if a.strip()]


def _read_optional_object(s3, bucket: str, key: str) -> str:
    """The object's UTF-8 text, or "" when S3 says it is missing or may not be read.

    A denied read is tolerated as empty on purpose: the two CSVs serve different Lambdas with
    different grants, and an approve must not fail with a 502 because the half this Lambda does
    not use was never seeded. The warning names the code so a real permissions gap is visible.
    """
    try:
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code not in _MISSING_OBJECT_CODES:
            raise
        logger.warning("s3://%s/%s not loaded (%s); treating as empty", bucket, key, code)
        return ""


def _fold(text: str) -> str:
    """Case- and punctuation-insensitive comparison key: 'Westbrook & Co.' == 'westbrook and co'."""
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


class SecurityMaster:
    """In-memory issuer and counterparty reference data with the two lookups the pipeline needs."""

    def __init__(self, issuers: list[dict], counterparties: list[dict]):
        """Build from already-parsed rows; prefer the ``from_*`` constructors.

        :param issuers: rows with ``aliases`` already split into a list.
        :param counterparties: rows ``{canonical_name, aliases: list[str]}``.
        """
        self.issuers = issuers
        self.counterparties = counterparties
        # Longest name first so "Cascade Midstream Partners" wins over its shorter alias when both
        # appear, and the whole-word regex is compiled once per name rather than per lookup.
        self._issuer_names: list[tuple[re.Pattern, dict]] = sorted(
            (
                (re.compile(rf"(?<!\w){re.escape(name)}(?!\w)", re.IGNORECASE), row)
                for row in issuers
                for name in [row["issuer_name"], *row["aliases"]]
            ),
            key=lambda pair: -len(pair[0].pattern),
        )
        self._canonical_by_fold: dict[str, str] = {}
        for row in counterparties:
            self._canonical_by_fold[_fold(row["canonical_name"])] = row["canonical_name"]
            for alias in row["aliases"]:
                self._canonical_by_fold.setdefault(_fold(alias), row["canonical_name"])

    @classmethod
    def from_csv_text(cls, issuers_csv: str, counterparties_csv: str) -> "SecurityMaster":
        """Parse the two CSV texts. Either may be empty (header only or "") to disable that half."""
        issuers = []
        for row in csv.DictReader(io.StringIO(issuers_csv)):
            if not (row.get("issuer_name") or "").strip():
                continue
            issuers.append({**row, "aliases": _split_aliases(row.get("aliases"))})
        counterparties = []
        for row in csv.DictReader(io.StringIO(counterparties_csv)):
            name = (row.get("canonical_name") or "").strip()
            if name:
                counterparties.append(
                    {"canonical_name": name, "aliases": _split_aliases(row.get("aliases"))}
                )
        return cls(issuers, counterparties)

    @classmethod
    def from_directory(cls, directory: str | Path) -> "SecurityMaster":
        """Load ``issuers.csv`` and ``counterparties.csv`` from a local directory (tests, seeding)."""
        directory = Path(directory)
        return cls.from_csv_text(
            (directory / ISSUERS_FILE).read_text(encoding="utf-8"),
            (directory / COUNTERPARTIES_FILE).read_text(encoding="utf-8"),
        )

    @classmethod
    def from_s3(cls, s3, bucket: str, prefix: str) -> "SecurityMaster":
        """Load both CSVs from ``s3://bucket/<prefix><file>``; a missing or unreadable object is empty.

        Missing is tolerated because the two halves serve different Lambdas: the parser only needs
        issuers and the OMS validator only needs counterparties, and neither should fail because
        the other half was not seeded (or, without ``s3:ListBucket``, answers 403 instead of 404).
        """
        prefix = prefix if not prefix or prefix.endswith("/") else prefix + "/"
        return cls.from_csv_text(
            _read_optional_object(s3, bucket, prefix + ISSUERS_FILE),
            _read_optional_object(s3, bucket, prefix + COUNTERPARTIES_FILE),
        )

    @classmethod
    def counterparties_from_s3(cls, s3, bucket: str, key: str) -> "SecurityMaster":
        """Load only the counterparty CSV at ``key``; issuers stay empty.

        For the OMS validator, whose role is granted ``s3:GetObject`` on the counterparty object
        and nothing else it would need for issuers -- so it must not even ask for them.
        """
        return cls.from_csv_text("", _read_optional_object(s3, bucket, key))

    def match_issuer(self, text: str) -> dict | None:
        """Find the issuer named in ``text`` by whole-word, case-insensitive name or alias match.

        Longer names take precedence, so a subject naming "Cascade Midstream Partners, LLC" resolves
        to that issuer even though "Cascade Midstream" is also an alias. Punctuation between words
        is tolerated because the email spelling ("Summit Safety Services, Inc.") rarely matches the
        master exactly.

        :param text: an issuer name, a subject line or a whole email body.
        :returns: the issuer row (aliases as a list) or None.
        """
        if not text:
            return None
        haystack = " ".join(text.split())
        for pattern, row in self._issuer_names:
            if pattern.search(haystack):
                return row
        return None

    def canonical_counterparty(self, name: str) -> tuple[str | None, str | None]:
        """Resolve an arranger name against the OMS counterparty list.

        :param name: the arranger name as written in the email or the staging CSV.
        :returns: ``(canonical, suggestion)``. ``canonical`` is the OMS name when ``name`` IS a
            canonical spelling (case/punctuation-insensitive) and None otherwise -- aliases are not
            accepted, which is exactly the ``LEFT_AGENT_UNKNOWN`` gap the learning loop closes.
            ``suggestion`` is the nearest canonical name: an alias resolves to its canonical, then
            ``difflib`` finds the closest canonical or alias spelling; None when nothing is close.
        """
        folded = _fold(name or "")
        if not folded:
            return None, None
        canonicals = {
            _fold(row["canonical_name"]): row["canonical_name"] for row in self.counterparties
        }
        if folded in canonicals:
            return canonicals[folded], canonicals[folded]
        if folded in self._canonical_by_fold:
            return None, self._canonical_by_fold[folded]
        close = difflib.get_close_matches(folded, list(self._canonical_by_fold), n=1, cutoff=0.6)
        if close:
            return None, self._canonical_by_fold[close[0]]
        # "Silverline Partners-led arranger group": a canonical name buried in longer text.
        for key, canonical in self._canonical_by_fold.items():
            if re.search(rf"(?<!\w){re.escape(key)}(?!\w)", folded):
                return None, canonical
        return None, None

    def canonical_names(self) -> list[str]:
        """The OMS canonical counterparty names in file order."""
        return [row["canonical_name"] for row in self.counterparties]
