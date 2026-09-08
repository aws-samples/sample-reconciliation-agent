"""Closes the gap between the two address sweeps under ``data/``.

``tests/input_corpus/`` sweeps ``data/input/`` and ``tests/kb_seed/`` sweeps ``data/kb-seed/``, and
AGENT.md states the rule as covering all of ``data/``. It did not: anything sitting outside those two
directories was unguarded, and that is exactly where a real Microsoft 365 tenant domain accumulated
in ``contacts-from-synthetic-corpus.md`` — a document *about* keeping addresses undeliverable. A
partial sweep behind a whole-directory claim is worse than no sweep, because it is trusted.

So this walks everything under ``data/`` that the other two do not, and asserts the same property:
every address sits in a domain that cannot receive mail.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"

# Swept by tests/input_corpus/ and tests/kb_seed/ respectively. Re-sweeping them here would double
# the runtime and, worse, split ownership of a failure across two files.
ALREADY_SWEPT = ("input", "kb-seed")

# RFC 2606 / RFC 6761 reserve these for documentation. Nothing here can resolve or be delivered to.
RESERVED_REGISTRABLE_DOMAINS = frozenset({"example.com", "example.net", "example.org"})
RESERVED_TLDS = frozenset({"invalid", "test", "example", "localhost"})

# Not RFC-reserved, and deliberately admitted anyway. A Microsoft 365 tenant domain has the shape
# `<name>.onmicrosoft.com`, so the docs cannot teach an operator to substitute their own tenant
# without writing one down. `contoso` is Microsoft's own documentation placeholder and is the only
# name allowed to stand in for a real tenant; a real one belongs in the gitignored tfvars.
ALLOWED_PLACEHOLDER_DOMAINS = frozenset({"contoso.com", "contoso.onmicrosoft.com"})

ADDRESS_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")


def _undeliverable(address: str) -> bool:
    """Report whether an address sits in a domain that cannot receive mail.

    :param address: the address to check.
    :returns: True when its domain is reserved for documentation, or is the tenant placeholder.
    """
    domain = address.rsplit("@", 1)[1].lower()
    labels = domain.split(".")
    return (
        domain in ALLOWED_PLACEHOLDER_DOMAINS
        or ".".join(labels[-2:]) in RESERVED_REGISTRABLE_DOMAINS
        or labels[-1] in RESERVED_TLDS
    )


def _unswept_files() -> list[Path]:
    """Return every file under ``data/`` that the other two sweeps do not cover.

    :returns: sorted list of paths.
    """
    return sorted(
        path
        for path in DATA_DIR.rglob("*")
        if path.is_file() and path.relative_to(DATA_DIR).parts[0] not in ALREADY_SWEPT
    )


UNSWEPT = _unswept_files()


def test_the_sweep_found_files() -> None:
    """Fail loudly if the glob finds nothing — otherwise the sweep below passes vacuously."""
    assert UNSWEPT, f"no unswept files under {DATA_DIR}"


@pytest.mark.parametrize("source", UNSWEPT, ids=lambda path: path.name)
def test_every_address_is_undeliverable(source: Path) -> None:
    """No address that could receive mail may sit in the committed corpus.

    :param source: the file being swept.
    """
    text = source.read_text(encoding="utf-8", errors="replace")
    offenders = sorted({a for a in ADDRESS_PATTERN.findall(text) if not _undeliverable(a)})
    assert not offenders, f"{source.name} contains deliverable addresses: {offenders}"
