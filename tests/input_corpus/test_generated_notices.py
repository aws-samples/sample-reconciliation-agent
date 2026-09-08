"""Guards on the notice corpus under ``data/input/``.

Two properties, both of which fail silently without a test:

* **no real email address may enter the corpus.** These documents are committed to git, uploaded to S3,
  read by an extraction pipeline and quoted back in an agent's reasoning. A genuine counterparty address
  landing here is an undetected leak in four places, and secret scanners will not flag it — gitleaks
  looks for credentials, not correspondents. The only defence is that every domain is reserved by
  RFC 2606 / 6761 and therefore cannot resolve. This mirrors the identical sweep over ``data/kb-seed/``.

* **the generated notices match their generator.** They are build artefacts. A hand-edited PDF would
  diverge from the script that documents what each one is FOR, and nothing else would notice.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
INPUT_DIR = REPO_ROOT / "data" / "input"
GENERATOR = REPO_ROOT / "scripts" / "generate_input_notices.py"

# RFC 2606 / RFC 6761 reserve these for documentation. Nothing here can resolve or be delivered to.
RESERVED_REGISTRABLE_DOMAINS = frozenset({"example.com", "example.net", "example.org"})
RESERVED_TLDS = frozenset({"invalid", "test", "example", "localhost"})

ADDRESS_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")


def _reserved(address: str) -> bool:
    """Report whether an address sits in a reserved, undeliverable domain.

    :param address: the address to check.
    :returns: True when its domain is reserved for documentation use.
    """
    labels = address.rsplit("@", 1)[1].lower().split(".")
    return ".".join(labels[-2:]) in RESERVED_REGISTRABLE_DOMAINS or labels[-1] in RESERVED_TLDS


def _scannable() -> list[Path]:
    """Return every file whose bytes should be swept for addresses.

    ``.pdf`` is included because both generators write UNCOMPRESSED content streams, so the text is
    greppable in the raw bytes. That is not incidental — a compressed stream would hide a real address
    from this sweep while leaving it perfectly readable to a human opening the file.

    :returns: sorted list of paths.
    """
    files = [
        path
        for path in INPUT_DIR.rglob("*")
        if path.is_file() and path.suffix in {".pdf", ".md", ".txt"}
    ]
    return sorted([*files, GENERATOR])


SCANNABLE = _scannable()


def test_the_sweep_found_files() -> None:
    """Fail loudly if the glob finds nothing — otherwise the sweep below passes vacuously."""
    assert SCANNABLE, f"no scannable files under {INPUT_DIR}"


@pytest.mark.parametrize("source", SCANNABLE, ids=lambda path: path.name)
def test_every_address_uses_a_reserved_domain(source: Path) -> None:
    """No real email address may enter the input corpus.

    :param source: the file being swept.
    """
    text = source.read_text(encoding="utf-8", errors="replace")
    offenders = sorted({a for a in ADDRESS_PATTERN.findall(text) if not _reserved(a)})
    assert not offenders, f"{source.name} contains non-reserved addresses: {offenders}"


def test_the_generated_notices_match_their_generator() -> None:
    """The six generated notices are build artefacts; a hand-edit would silently diverge.

    Run in a subprocess rather than by importing, because the generator's ``--check`` mode is the
    contract an operator uses and this asserts that contract rather than a private function.
    """
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, (
        f"generated notices are stale — run: python3 scripts/generate_input_notices.py\n"
        f"{result.stdout}{result.stderr}"
    )


def test_no_generated_notice_carries_a_real_looking_identifier() -> None:
    """CUSIPs and ISINs must stay inside the synthetic series documented in data/README.md.

    A plausible-looking identifier is the one kind of synthetic value that can be mistaken for real
    market data, and unlike an address it will never be flagged by anything else.
    """
    allowed_prefixes = ("SYN", "12345", "23456", "34567", "US12345", "US23456", "US34567")
    pattern = re.compile(r"\b(?:US[0-9A-Z]{10}|[0-9]{5}[0-9A-Z]{4})\b")
    # `is_file()` is required, not defensive: the IDP baseline layout under `idp-evaluation/` puts each
    # document's ground truth in a DIRECTORY named `<document>.pdf`, which this glob also matches.
    for path in INPUT_DIR.rglob("*.pdf"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for found in pattern.findall(text):
            assert found.startswith(allowed_prefixes), (
                f"{path.name} carries {found!r}, which is outside the synthetic identifier series"
            )
