#!/usr/bin/env python3
"""Seed the recon-items table with six fictional reconciliation items, so a fresh deployment
demonstrates the Trade Reconciliation app instead of showing an empty queue.

WHY THIS EXISTS. The Deal Pipeline app seeds its own demo corpus at apply time (seven fictional
new-issue emails, `data/deal-emails/`), so it demonstrates itself. Recon does not: a `ReconItem` row
reaches the items table only from the intake API or from a structured feed, and neither exists on a
first apply. The queue, the dashboard and the case screen are therefore all empty, which is a poor
demo and a worse local test -- there is nothing to click, and no way to tell "working with no data"
from "broken".

WHY ITEMS AND NOT CASES. `recon-<env>-items` is the platform's ONLY stream-enabled table, and an item
write is what opens a case: the Tier-1 Lambda consumes the stream, runs the deterministic engine
(`backend/tier1/engine.py`), and either auto-clears the item into a terminal case or opens a PENDING
one for the Tier-2 agent. Writing cases directly would skip all of that -- the case rows would carry
no `tier1_match` evidence, no `tier1_escalation_reason`, no `tier1_break_type`, and nothing would ever
dispatch the agent. Seeding items exercises the real path, so what you see afterwards is what the
platform decided, not what this script asserted.

WHAT IT SEEDS. Six items in domain `cash` (the only domain Tier-1 has a rule for), chosen so that they
land in visibly DIFFERENT states rather than merely filling rows. Every amount, borrower and facility
is taken from `data/general-ledger/gl-entries.csv` -- the mocked ledger the gl-query Lambda serves
through Athena -- so the two items that must be looked up in the ledger correspond to rows that
actually exist there:

    01-autoclear-interest    AUTO_CLEARED  amount-match   2 sides, |diff| 0.02 <= 0.05 tolerance
    02-amount-mismatch       PENDING       tolerance_miss 2 sides differing by 3,655.20
    03-ledger-match          AUTO_CLEARED  gl-match       0 sides, exactly ONE ledger row matches
    04-ledger-ambiguous      PENDING       gl_ambiguous   0 sides, TWO ledger rows match
    05-missing-amount        PENDING       missing_match_attr  the expected side omits `amount`
    06-unparseable-amount    PENDING       unparseable_amount  the expected side says "n/a"

Items 05 and 06 are the pair worth understanding: the engine names them differently on purpose,
because "the amount is missing" is an upstream data-quality problem and "the amount is not a number"
is a different one, and neither is a reconciliation difference. Items 03 and 04 are the ledger pair:
one is unambiguous and clears with no LLM involved at all, the other names two candidate ledger rows
under one wire reference and hands the aggregation judgement to the agent.

WHAT YOU SHOULD SEE IN THE CONSOLE. Give Tier-1 a few seconds -- the stream trigger is `LATEST` with a
batch of 10, so all six arrive in one or two invocations, and the deterministic tier makes its decision
without a model:

* `/recon/queue` (default OPEN filter) lists the FOUR escalated cases, PENDING. Each one's detail
  screen shows the `tier1_escalation_reason` above, and a `tier1_break_type` of `record-match-review`
  (items 02, 05, 06 -- two sides) or `ledger-status-resolution` (item 04 -- no sides).
* Switch the queue's status filter to AUTO_CLEARED to see the TWO items Tier-1 resolved by itself.
  Their case rows carry `tier1_match`: item 01's says `matched_on: rule` with both compared values and
  the margin, item 03's says `matched_on: general_ledger` and embeds the matched ledger row.
* The escalated four then move on their own. Tier-1 nudges the Tier-2 map run on any escalation, and
  the run is also scheduled every minute, so a case goes PENDING -> IN_PROGRESS -> PROPOSED without
  anyone pressing anything. Expect a proposal within a couple of minutes, which is model latency and
  not this script's. A case that stays PENDING means the agent tier is not running; one that reaches
  FAILED means the investigation errored, and the trace on the case says where.

Item 03 and 04 depend on the ledger lookup, which the Tier-1 Lambda performs only when its
`GL_QUERY_FUNCTION` environment variable is set (it is, in `infra/modules/tier1`). Without it a
sides-less item escalates as `side_count` instead, and with a broken Athena/Lake Formation setup it
escalates as `gl_query_failed`. Both are legitimate outcomes to read off the case, not failures of this
script.

Those two items are also the only place this script sets `idp_class` and `idp_attributes`, which
`assets/intake-http-api.md` tells callers of the intake API not to supply. That rule is about the API:
an operator hand-typing a payload has no extraction behind those keys, so a value there is a claim
about a document that does not exist. Here they are the point -- `backend/tier1/gl_match.py` reads the
borrower, the class and the amounts out of exactly those two keys and from nowhere else, so they are
what makes the deterministic ledger path reachable at all. Nothing else in a deployed stack writes a
sides-less item today (the IDP hook maps a document to a Notice, deliberately, so that an extracted
document does not create a case), which is why this is the only way to see that path work.

FICTIONAL. Every name here is from this repo's own synthetic corpus: the borrowers and facilities are
`data/general-ledger/gl-entries.csv`, the agent bank is the one the notice corpus prints
(`scripts/generate_input_notices.py`), and the fund labels are the alias table in the shipped
`record-match-review` skill. No real company, person, bank or address appears, and none may be added.

IDEMPOTENT. Every id is derived from a fixed prefix, ordinal and scenario name -- no clock, no uuid --
and the write is the same conditional put intake uses (`attribute_not_exists(item_id)`), so a second
run reports six SKIPPED and writes nothing. That also means a re-run never re-fires Tier-1 for an item
already in flight.

    # See exactly what it would write, resolving the table from Terraform's state. Touches nothing.
    python3 scripts/seed_recon_demo_items.py --dry-run --profile <profile>

    # Seed all six.
    python3 scripts/seed_recon_demo_items.py --profile <profile>

    # One scenario at a time, against a table named explicitly (no Terraform state needed).
    python3 scripts/seed_recon_demo_items.py --items-table recon-dev-items --region us-east-1 \\
        --scenario ledger-match --scenario ledger-ambiguous

    # Remove them. Deletes ONLY the six ids above, by exact key -- never a scan.
    python3 scripts/seed_recon_demo_items.py --delete --dry-run
    python3 scripts/seed_recon_demo_items.py --delete

⚠️ `--delete` removes the ITEMS and nothing else. The cases Tier-1 derived from them live in
`recon-<env>-cases` and are not this script's to remove: `CaseStore.open` is conditional on the case
id, which IS the item id, so re-seeding after a delete recreates the items and Tier-1 then reports
`DUPLICATE_SKIPPED` for every one of them -- the console keeps showing the original six cases. That is
the right default (a case carries an analyst's decisions and an append-only audit trail), but it means
"delete then re-seed" is not how you reset the demo. To start over, delete the six case rows for the
same ids as well, which the delete run prints the command for.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

# This script builds real `ReconItem` models rather than dicts, so the repo root has to be importable
# when it is run as `python3 scripts/...` (which puts `scripts/` on the path, not the root) -- the same
# setup `backfill_notice_search_index.py` does, for the same reason. Validating against the shipped
# model is the point: a seeded row that intake would have rejected is a demo that proves nothing, and
# the escalation reasons are imported rather than retyped so the expectations below cannot drift from
# the engine that produces them.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.recon_core.schema import ReconItem, ReconSide  # noqa: E402  (path set up above)
from backend.tier1.engine import (  # noqa: E402
    ESCALATION_MISSING_MATCH_ATTR,
    ESCALATION_TOLERANCE_MISS,
    ESCALATION_UNPARSEABLE_AMOUNT,
)
from backend.tier1.gl_match import GL_AMBIGUOUS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TERRAFORM_DIR = REPO_ROOT / "infra" / "environments" / "recon"

# The Terraform output naming the table. `infra/modules/foundation` exposes `items_table`; the recon
# root does not re-export it yet, which is why the failure below names the flag as well as the output.
ITEMS_TABLE_OUTPUT = "items_table"

# Every id starts with this, and `delete_item` REFUSES anything that does not. That refusal is the
# whole safety property of `--delete`: this script never scans the table and never decides what to
# remove from what it finds there, so it cannot delete a row an analyst or the intake API wrote.
ID_PREFIX = "recon-demo-"

# The only domain `backend/tier1/handler.py`'s `_RULES` configures. An item in any other domain
# escalates as `no_rule` and demonstrates nothing about matching.
DOMAIN = "cash"

# The two auto-clear categories, as `backend/tier1/handler.py` writes them: the engine's rule category
# (`_RULES["cash"]["category"]`) and the constant the ledger path uses. Copied rather than imported
# because both are private to that module; tests/scripts/test_seed_recon_demo_items.py asserts the
# first one still equals the rule table's, since a drifted copy would only ever be visible as an
# expectation line that quietly stopped matching the console.
CATEGORY_RULE_MATCH = "amount-match"
CATEGORY_GL_MATCH = "gl-match"

# Statuses `backend/tier1/handler.py` opens a case in, as `CaseStatus` spells them.
STATUS_AUTO_CLEARED = "AUTO_CLEARED"
STATUS_PENDING = "PENDING"

# The agent bank the synthetic notice corpus prints (scripts/generate_input_notices.py) and the fund
# labels from the shipped skills' alias table. Fictional, and shared with the rest of the sample so the
# seeded items read as part of one corpus rather than as a second invented world.
AGENT_BANK = "Tarnsmoor Trust Bank, N.A."
FUND_DL_I = "Direct Lending Fund I"
FUND_DL_II = "Direct Lending Fund II"
FUND_SCF = "Senior Credit Fund"


@dataclass(frozen=True)
class DemoItem:
    """One seeded item, with what Tier-1 will do to it and why.

    The expectation travels WITH the item rather than living in the README, because it is what makes
    this a demonstration rather than six rows: an operator reads the run's own report to know which
    case to open and what it should say. ``ledger_entry`` names the row in
    ``data/general-ledger/gl-entries.csv`` the amounts came from, which is what keeps the ledger-lookup
    scenarios honest -- an item citing a borrower the ledger has never heard of proves nothing.
    """

    scenario: str
    item: ReconItem
    expect_status: str
    # The auto-clear category, or the `tier1_escalation_reason` the engine will name.
    expect_detail: str
    expectation: str
    ledger_entry: str


def _item_id(ordinal: int, scenario: str) -> str:
    """Build the deterministic id for one scenario.

    Derived from the prefix, a stable ordinal and the scenario name -- never a clock or a uuid. That is
    what makes a second run a no-op instead of a duplicate, and what lets ``--delete`` address exactly
    these six rows by key.

    :param ordinal: the scenario's position, 1-based, zero-padded to two digits.
    :param scenario: the scenario handle, as ``--scenario`` accepts it.
    :returns: the item id.
    """
    return f"{ID_PREFIX}{ordinal:02d}-{scenario}"


def _side(name: str, **attributes: str) -> ReconSide:
    """Build one side of an item.

    :param name: the side's label, e.g. ``bank`` or ``ledger``.
    :param attributes: the side's attributes; every value must be a string, because
        ``ReconSide.attributes`` is ``dict[str, str]`` and pydantic v2 does not coerce numbers.
    :returns: the side.
    """
    return ReconSide(name=name, attributes=dict(attributes))


def _source_refs(ledger_entry: str) -> list[str]:
    """Provenance for a seeded item: this script, and the ledger row its figures came from.

    Deliberately NOT an ``idp:documentId=...`` ref, which is what a document-derived item carries. No
    document produced these rows, and a ref naming one would put a false provenance on the case screen.

    :param ledger_entry: the ``entry_id`` in ``data/general-ledger/gl-entries.csv``.
    :returns: the source refs.
    """
    return ["seed:scripts/seed_recon_demo_items.py", f"gl-entry:{ledger_entry}"]


def _demo_items() -> tuple[DemoItem, ...]:
    """Build the six demonstration items.

    Every figure is read off ``data/general-ledger/gl-entries.csv``, so the ledger the agent and the
    deterministic lookup both query already contains the counterpart. The order is the order they are
    reported in, and the ordinals are part of the ids, so inserting a scenario in the middle renames
    the ones after it -- append instead.

    :returns: the demonstration items, in report order.
    """
    return (
        # ---- 1. Auto-clears on the deterministic rule -------------------------------------------
        # GL-2026-000107: NORTHWIND MANUFACTURING LLC interest payment share, 1,512,361.04 USD CREDIT,
        # FUND-DL-II, TERM LOAN A / LX0063110. The bank states two cents more than the book, which is
        # inside the 0.05 tolerance, so `reconcile` resolves it and the agent never runs.
        DemoItem(
            scenario="autoclear-interest",
            item=ReconItem(
                item_id=_item_id(1, "autoclear-interest"),
                domain=DOMAIN,
                sides=[
                    _side(
                        "bank",
                        amount="1512361.06",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                        loanx_id="LX0063110",
                    ),
                    _side(
                        "ledger",
                        amount="1512361.04",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                        loanx_id="LX0063110",
                    ),
                ],
                source_refs=_source_refs("GL-2026-000107"),
                attributes={
                    "activity_type": "Interest",
                    "agent_bank": AGENT_BANK,
                    "counterparty": "NORTHWIND MANUFACTURING LLC",
                    "facility": "NORTHWIND TERM LOAN A",
                    "fund": FUND_DL_II,
                    "value_date": "2026-09-30",
                },
            ),
            expect_status=STATUS_AUTO_CLEARED,
            expect_detail=CATEGORY_RULE_MATCH,
            expectation=(
                "the two sides differ by 0.02, inside the 0.05 tolerance, so Tier-1 resolves it "
                "deterministically and no model runs"
            ),
            ledger_entry="GL-2026-000107",
        ),
        # ---- 2. Escalates because the amounts really disagree -----------------------------------
        # GL-2026-000106: NORTHWIND prepayment share, 842,155.20 USD CREDIT, FUND-DL-II, under wire
        # NW-PREPAY-1107. The book carries a stale figure, so the difference is 3,655.20 -- far outside
        # tolerance, and a genuine break for the agent to investigate against the ledger.
        DemoItem(
            scenario="amount-mismatch",
            item=ReconItem(
                item_id=_item_id(2, "amount-mismatch"),
                domain=DOMAIN,
                sides=[
                    _side(
                        "bank",
                        amount="842155.20",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                        reference="NW-PREPAY-1107",
                    ),
                    _side(
                        "ledger",
                        amount="838500.00",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                        reference="NW-PREPAY-1107",
                    ),
                ],
                source_refs=_source_refs("GL-2026-000106"),
                attributes={
                    "activity_type": "Paydown",
                    "agent_bank": AGENT_BANK,
                    "counterparty": "NORTHWIND MANUFACTURING LLC",
                    "facility": "NORTHWIND INITIAL TERM LOANS",
                    "fund": FUND_DL_II,
                    "value_date": "2026-11-07",
                },
            ),
            expect_status=STATUS_PENDING,
            expect_detail=ESCALATION_TOLERANCE_MISS,
            expectation=(
                "both sides are booked and disagree by 3,655.20, so Tier-1 escalates and the agent "
                "compares them against the ledger row for the same wire"
            ),
            ledger_entry="GL-2026-000106",
        ),
        # ---- 3. Auto-clears on the deterministic LEDGER lookup ----------------------------------
        # No sides at all, which is the shape an item derived from an extracted document has: there is
        # nothing to compare it against except the ledger. GL-2026-000108 is the only MISTFELL FOODS
        # CORP. row a CREDIT of 618,750.00 can settle (the borrower's other two rows are commitment
        # fees of 446.67 USD and 412.50 EUR), so exactly one row survives all three filters and
        # `gl_lookup` clears it with no LLM involved.
        DemoItem(
            scenario="ledger-match",
            item=ReconItem(
                item_id=_item_id(3, "ledger-match"),
                domain=DOMAIN,
                sides=[],
                source_refs=_source_refs("GL-2026-000108"),
                attributes={
                    # `paydown_notice` is a class id from data/idp-extraction-config/classes.json, and
                    # `_derive_entry_type` reads "paydown" out of it as a CREDIT to the cash account.
                    "idp_class": "paydown_notice",
                    "idp_attributes": {
                        # ⚠️ `BorrowerName` is the ONE key here that is not the extraction config's
                        # own vocabulary. `backend/tier1/gl_match.py`'s `_borrower` reads exactly this
                        # name and no other, so the ledger lookup cannot find a borrower without it.
                        # The snake_case keys beside it are the config's, for the agent to read.
                        "BorrowerName": "MISTFELL FOODS CORP.",
                        "counterparty": "MISTFELL FOODS CORP.",
                        "activity_type": "Mandatory Paydown",
                        "agent_bank": AGENT_BANK,
                        # The FUND-level share, which is the amount a ledger row settles.
                        "amount": "618750.00",
                        # The facility-wide total, which covers every fund on the facility and matches
                        # no single row. Present so the two are visibly different figures, as the
                        # `record-match-review` skill insists they are.
                        "global_amount": "2475000.00",
                        "currency": "USD",
                        "facility": "MISTFELL INITIAL TERM LOANS",
                        "fund": FUND_SCF,
                        "loanx_id": "LX0052901",
                        "notice_date": "2026-09-12",
                        "reference": "MF-ECF-0915",
                        "value_date": "2026-09-15",
                    },
                },
            ),
            expect_status=STATUS_AUTO_CLEARED,
            expect_detail=CATEGORY_GL_MATCH,
            expectation=(
                "no sides, so Tier-1 looks the borrower up in the mocked general ledger; exactly one "
                "CREDIT row is within tolerance of the extracted share, so it auto-clears with the "
                "matched ledger row stored on the case"
            ),
            ledger_entry="GL-2026-000108",
        ),
        # ---- 4. The ledger lookup finds TWO candidates and refuses to choose --------------------
        # One wire, WIRE-20260302-EVG, settling two CINDERMOOR facilities: GL-2026-000104 (interest,
        # 9,640.18, TL-A) and GL-2026-000105 (paydown, 12,500.00, TL-B). Both are CREDITs within
        # tolerance of an amount this advice carries, so `gl_lookup` returns GL_AMBIGUOUS rather than
        # picking one, attaches the near-miss rows as `gl_candidates`, and the aggregation judgement
        # goes to the agent -- which is exactly the distinction the module's docstring says earns its
        # keep, since "the ledger has nothing" is a different investigation from "it is in there twice".
        DemoItem(
            scenario="ledger-ambiguous",
            item=ReconItem(
                item_id=_item_id(4, "ledger-ambiguous"),
                domain=DOMAIN,
                sides=[],
                source_refs=_source_refs("GL-2026-000104"),
                attributes={
                    # "payment" in the class id derives the CREDIT direction.
                    "idp_class": "consolidated_payment_advice",
                    "idp_attributes": {
                        "BorrowerName": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                        "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                        "activity_type": "Consolidated Payment",
                        "agent_bank": AGENT_BANK,
                        "currency": "USD",
                        "fund": FUND_DL_I,
                        "notice_date": "2026-02-26",
                        "reference": "WIRE-20260302-EVG",
                        "value_date": "2026-03-02",
                        # Two components under one wire. `extract_candidate_amounts` walks nested
                        # structures and keeps the numeric leaves under amount-like keys, so both of
                        # these are candidates and each finds its own ledger row.
                        "payment_components": [
                            {
                                "activity_type": "Interest",
                                "amount": "9640.18",
                                "facility": "CINDERMOOR LOGISTICS TL-A $160MM",
                            },
                            {
                                "activity_type": "Paydown",
                                "amount": "12500.00",
                                "facility": "CINDERMOOR LOGISTICS TL-B $250MM",
                            },
                        ],
                    },
                },
            ),
            expect_status=STATUS_PENDING,
            expect_detail=GL_AMBIGUOUS,
            expectation=(
                "no sides and TWO ledger rows within tolerance -- one wire settling two facilities -- "
                "so the deterministic lookup refuses to choose, attaches both as gl_candidates and "
                "escalates the aggregation judgement to the agent"
            ),
            ledger_entry="GL-2026-000104 + GL-2026-000105",
        ),
        # ---- 5. Deliberately incomplete: the expected side has no amount ------------------------
        # GL-2026-000109: NORTHWIND interest lender share, 23.73 USD CREDIT on the revolver. The
        # expected side arrived without its amount column at all, which the engine names
        # `missing_match_attr` -- a data-quality problem upstream, NOT a reconciliation difference, and
        # the agent is told which of the two it is looking at.
        DemoItem(
            scenario="missing-amount",
            item=ReconItem(
                item_id=_item_id(5, "missing-amount"),
                domain=DOMAIN,
                sides=[
                    _side(
                        "bank",
                        amount="23.73",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                        reference="NW-INT-0126",
                    ),
                    # No `amount` key AT ALL -- not "0.00", which is a booked zero and a different
                    # break. This is the shape a feed produces when the column never arrived.
                    _side(
                        "ledger",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="NORTHWIND MANUFACTURING LLC",
                    ),
                ],
                source_refs=_source_refs("GL-2026-000109"),
                attributes={
                    "activity_type": "Interest",
                    "agent_bank": AGENT_BANK,
                    "counterparty": "NORTHWIND MANUFACTURING LLC",
                    "facility": "NORTHWIND REVOLVING CREDIT FACILITY",
                    "fund": FUND_DL_II,
                    "value_date": "2026-01-26",
                },
            ),
            expect_status=STATUS_PENDING,
            expect_detail=ESCALATION_MISSING_MATCH_ATTR,
            expectation=(
                "the expected side omits `amount` entirely, so there is nothing to compare; Tier-1 "
                "escalates naming the missing attribute rather than reporting a difference"
            ),
            ledger_entry="GL-2026-000109",
        ),
        # ---- 6. Deliberately ambiguous: the amount is present but is not a number ---------------
        # GL-2026-000103: CINDERMOOR rollover interest component, 4,182.55 USD CREDIT. The expected
        # side says "n/a", which `Decimal` refuses -- so this lands in `unparseable_amount`, the reason
        # that exists precisely so the agent can tell it apart from item 05. It is also a ROLLOVER,
        # which proves a rate was reset rather than that cash was due, so a well-behaved investigation
        # must refuse to call it a confirmed cash match however well everything else lines up.
        DemoItem(
            scenario="unparseable-amount",
            item=ReconItem(
                item_id=_item_id(6, "unparseable-amount"),
                domain=DOMAIN,
                sides=[
                    _side(
                        "bank",
                        amount="4182.55",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="CINDERMOOR LOGISTICS HOLDINGS INC.",
                        reference="WIRE-20260302-EVG",
                    ),
                    _side(
                        "ledger",
                        # Present, and not a number. An empty string lands here too.
                        amount="n/a",
                        currency="USD",
                        entry_type="CREDIT",
                        account_name="CINDERMOOR LOGISTICS HOLDINGS INC.",
                    ),
                ],
                source_refs=_source_refs("GL-2026-000103"),
                attributes={
                    "activity_type": "Rollover",
                    "agent_bank": AGENT_BANK,
                    "counterparty": "CINDERMOOR LOGISTICS HOLDINGS INC.",
                    "facility": "CINDERMOOR REVOLVING CREDIT FACILITY $200MM",
                    "fund": FUND_DL_I,
                    "value_date": "2026-03-02",
                },
            ),
            expect_status=STATUS_PENDING,
            expect_detail=ESCALATION_UNPARSEABLE_AMOUNT,
            expectation=(
                'the expected side carries "n/a" where a number belongs, so Tier-1 escalates as a '
                "data-quality problem and NOT as an amount difference"
            ),
            ledger_entry="GL-2026-000103",
        ),
    )


# Built once, at import, so a change that makes an item invalid fails immediately and loudly rather
# than on the write.
DEMO_ITEMS: tuple[DemoItem, ...] = _demo_items()
SCENARIOS: tuple[str, ...] = tuple(demo.scenario for demo in DEMO_ITEMS)


# --- resolving the deployment ------------------------------------------------------------------


def terraform_outputs(*, directory: Path) -> dict[str, Any]:
    """Read `terraform output -json` from a Terraform root.

    Read-only: `output` renders the state that is already there and refreshes nothing. A sibling copy
    of this lives in `create_dev_users.py`; the two are deliberately not shared, because the useful
    part of the failure is the name of THIS script's override flag, and a common helper could only
    name one of them.

    :param directory: the Terraform root to read (``infra/environments/recon`` by default).
    :returns: the parsed output map, ``{name: {"value": ..., "sensitive": ...}}``.
    :raises RuntimeError: if terraform is absent, the directory is not a usable root, or the output is
        not JSON.
    """
    try:
        completed = subprocess.run(
            ["terraform", "output", "-json"],
            cwd=directory,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:  # terraform not on PATH
        raise RuntimeError(
            f"terraform is not on PATH, so {directory} cannot be read. Pass --items-table instead."
        ) from exc

    if completed.returncode != 0:
        raise RuntimeError(
            f"`terraform output -json` failed in {directory} (exit {completed.returncode}). Run "
            f"`terraform init -backend-config=backend.hcl` there first, or pass --items-table "
            f"instead.\n{completed.stderr.strip()}"
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"`terraform output -json` in {directory} did not return JSON") from exc


def resolve_items_table(*, outputs: dict[str, Any] | None, items_table: str | None) -> str:
    """Decide which DynamoDB table to write the items to.

    `--items-table` wins over the Terraform output, so a clone with no state, a second deployment or a
    moto table in a test all work without touching Terraform at all.

    :param outputs: parsed `terraform output -json`, or None when it was not consulted.
    :param items_table: the table name from the command line, if given.
    :returns: the resolved table name.
    :raises ValueError: when neither source names a table.
    """
    explicit = (items_table or "").strip()
    if explicit:
        return explicit
    from_output = str((outputs or {}).get(ITEMS_TABLE_OUTPUT, {}).get("value") or "").strip()
    if from_output:
        return from_output
    raise ValueError(
        f"no items table: --items-table was not given and there is no {ITEMS_TABLE_OUTPUT!r} "
        "Terraform output to read it from. `infra/modules/foundation` exposes that output but the "
        "recon root does not re-export it yet, so pass the name explicitly -- it is "
        "'<name_prefix>-items', e.g. --items-table recon-dev-items."
    )


def select_items(*, scenarios: list[str]) -> tuple[DemoItem, ...]:
    """Pick the scenarios to act on, in report order.

    :param scenarios: the ``--scenario`` values; empty means all of them.
    :returns: the selected items, always in :data:`DEMO_ITEMS` order regardless of argument order, so
        two runs asking for the same set report identically.
    :raises ValueError: when a name is not one of :data:`SCENARIOS`.
    """
    if not scenarios:
        return DEMO_ITEMS
    unknown = [name for name in scenarios if name not in SCENARIOS]
    if unknown:
        raise ValueError(
            f"--scenario named unknown scenario(s) {', '.join(unknown)}; expected one of "
            f"{', '.join(SCENARIOS)}"
        )
    wanted = set(scenarios)
    return tuple(demo for demo in DEMO_ITEMS if demo.scenario in wanted)


# --- writing and removing the rows -------------------------------------------------------------


def put_if_absent(*, table: Any, item: ReconItem) -> bool:
    """Write one item only if its id does not already exist.

    The same conditional put `backend/recon_core/ddb.py`'s `ItemStore.put_if_absent` performs, and for
    the same reason: a duplicate id must be SKIPPED rather than overwritten, so a re-run cannot
    re-trigger Tier-1 for an item already in flight. Written here against an injected ``table``
    instead of reusing `ItemStore`, which binds to the DEFAULT boto3 session and so could honour
    neither ``--profile`` nor ``--region`` nor a test's moto table.

    :param table: a boto3 DynamoDB ``Table`` resource for the items table.
    :param item: the item to write.
    :returns: True when the row was newly created, False when the id already existed.
    :raises botocore.exceptions.ClientError: any DynamoDB error other than the condition check.
    """
    try:
        table.put_item(
            Item=item.model_dump(),
            ConditionExpression="attribute_not_exists(item_id)",
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def delete_item(*, table: Any, item_id: str) -> bool:
    """Remove one seeded row by exact key, tolerating its absence.

    Refuses any id outside :data:`ID_PREFIX`. That refusal is not defensive padding: it is what makes
    ``--delete`` safe to run against a table holding real items. This script never scans the table, so
    the only ids it can ever pass here are the ones it builds -- and this check means a future caller
    that got that wrong fails instead of deleting somebody else's row.

    :param table: a boto3 DynamoDB ``Table`` resource for the items table.
    :param item_id: the row to delete.
    :returns: True when a row was deleted, False when there was none.
    :raises ValueError: when ``item_id`` does not start with :data:`ID_PREFIX`.
    :raises botocore.exceptions.ClientError: any DynamoDB error other than the condition check.
    """
    if not item_id.startswith(ID_PREFIX):
        raise ValueError(
            f"refusing to delete {item_id!r}: this script only ever removes ids beginning "
            f"{ID_PREFIX!r}, and never a row it did not write"
        )
    try:
        table.delete_item(
            Key={"item_id": item_id},
            ConditionExpression="attribute_exists(item_id)",
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def run_seed(*, table: Any, items: tuple[DemoItem, ...], dry_run: bool) -> dict[str, int]:
    """Write the selected items, printing one line each.

    :param table: a boto3 DynamoDB ``Table`` resource, or None under ``dry_run``.
    :param items: the selected demonstration items.
    :param dry_run: report what would be written, and write nothing.
    :returns: counts keyed ``written``, ``skipped``.
    """
    counts = {"written": 0, "skipped": 0}
    for demo in items:
        if dry_run:
            counts["written"] += 1
            print(f"  WOULD WRITE  {demo.item.item_id}")
            # What it would actually put: the validated model, exactly as the row would be stored.
            print(f"               {json.dumps(demo.item.model_dump(), sort_keys=True)}")
            continue
        if put_if_absent(table=table, item=demo.item):
            counts["written"] += 1
            print(f"  WRITE        {demo.item.item_id}")
        else:
            counts["skipped"] += 1
            print(f"  SKIP         {demo.item.item_id}: already present, left untouched")
    return counts


def run_delete(*, table: Any, items: tuple[DemoItem, ...], dry_run: bool) -> dict[str, int]:
    """Remove the selected items, printing one line each.

    :param table: a boto3 DynamoDB ``Table`` resource, or None under ``dry_run``.
    :param items: the selected demonstration items.
    :param dry_run: report what would be deleted, and delete nothing.
    :returns: counts keyed ``deleted``, ``absent``.
    """
    counts = {"deleted": 0, "absent": 0}
    for demo in items:
        item_id = demo.item.item_id
        if dry_run:
            counts["deleted"] += 1
            print(f"  WOULD DELETE {item_id}")
            continue
        if delete_item(table=table, item_id=item_id):
            counts["deleted"] += 1
            print(f"  DELETED      {item_id}")
        else:
            counts["absent"] += 1
            print(f"  ABSENT       {item_id}")
    return counts


def print_expectations(*, items: tuple[DemoItem, ...]) -> None:
    """Print what each seeded item should become, and why.

    The report an operator acts on: six ids is not useful without knowing which case to open and what
    it should say once Tier-1 has run.

    :param items: the selected demonstration items.
    :returns: None.
    """
    print("\nWhat Tier-1 should do with each (give it a few seconds):")
    for demo in items:
        print(f"  {demo.item.item_id}")
        print(f"      -> {demo.expect_status:<12} {demo.expect_detail:<20} ({demo.ledger_entry})")
        print(f"         {demo.expectation}")


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, resolve the table, and seed or remove the demonstration items.

    :param argv: argument vector, defaulting to ``sys.argv[1:]``.
    :returns: process exit status; 0 on success, 2 on a resolution or argument failure.
    """
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--items-table",
        default=None,
        help=f"the recon items table to write to; default: the {ITEMS_TABLE_OUTPUT} output of the "
        f"Terraform root below",
    )
    parser.add_argument(
        "--terraform-dir",
        type=Path,
        default=DEFAULT_TERRAFORM_DIR,
        help=f"Terraform root to read the table name from (default: "
        f"{DEFAULT_TERRAFORM_DIR.relative_to(REPO_ROOT)}). Not consulted when --items-table is given",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        default=[],
        metavar="NAME",
        help=f"seed (or delete) only this scenario; repeatable. One of {', '.join(SCENARIOS)}. "
        f"Default: all {len(SCENARIOS)}",
    )
    parser.add_argument("--profile", default=None, help="AWS profile to use")
    parser.add_argument("--region", default=None, help="AWS region the table is in")
    parser.add_argument(
        "--delete",
        action="store_true",
        help="remove the seeded items instead of writing them. Deletes ONLY ids beginning "
        f"{ID_PREFIX!r}, by exact key, and never a case row",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="report what would change and change nothing"
    )
    args = parser.parse_args(argv)

    try:
        items = select_items(scenarios=args.scenario)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    outputs: dict[str, Any] | None = None
    if not args.items_table:
        try:
            outputs = terraform_outputs(directory=args.terraform_dir)
        except RuntimeError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    try:
        items_table = resolve_items_table(outputs=outputs, items_table=args.items_table)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    # No client at all under --dry-run: nothing is read and nothing is written, so the run must not
    # need credentials or even a resolvable region to tell an operator what it would do.
    table = None
    if not args.dry_run:
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
        table = session.resource("dynamodb").Table(items_table)

    if args.delete:
        mode = "dry run (nothing will be deleted)" if args.dry_run else "DELETING"
        print(f"[recon-seed] {mode} {len(items)} demonstration item(s) in {items_table}")
        counts = run_delete(table=table, items=items, dry_run=args.dry_run)
        print(f"[recon-seed] deleted={counts['deleted']} absent={counts['absent']}")
        print(
            "[recon-seed] no case row was touched — the cases Tier-1 derived from these items are in "
            "the cases table, and an analyst's decisions and audit trail live on them."
        )
        # Only when something was actually removed: after a second delete run there is no case behind
        # these ids to warn about, and the advice would read as a problem rather than as a next step.
        if not args.dry_run and counts["deleted"]:
            print(
                "[recon-seed] re-seeding now recreates the items, but Tier-1 will report "
                "DUPLICATE_SKIPPED for each: a case already exists under the same id. To replay the "
                "demo from scratch, delete those case rows too, e.g.\n"
                + "\n".join(
                    f"             aws dynamodb delete-item --table-name <cases-table> "
                    f"--key '{{\"item_id\":{{\"S\":\"{demo.item.item_id}\"}}}}'"
                    for demo in items
                )
            )
        return 0

    mode = "dry run (nothing will be written)" if args.dry_run else "SEEDING"
    print(f"[recon-seed] {mode} {len(items)} demonstration item(s) into {items_table}")
    counts = run_seed(table=table, items=items, dry_run=args.dry_run)
    print(f"[recon-seed] written={counts['written']} skipped={counts['skipped']}")
    print_expectations(items=items)

    if args.dry_run:
        print("\n[recon-seed] nothing was written. Re-run without --dry-run.")
        return 0
    if counts["written"]:
        print(
            "\n[recon-seed] the items table is the only stream-enabled one, so Tier-1 is already "
            "running. Open /recon/queue for the escalations and switch the status filter to "
            "AUTO_CLEARED for the two it resolved itself."
        )
    else:
        print(
            "\n[recon-seed] every id already existed, so nothing was written and Tier-1 was not "
            "re-triggered. The cases from the first run are still in the console."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
