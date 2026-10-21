"""Tests for scripts/seed_recon_demo_items.py — the six demonstration items a fresh recon
deployment needs before its queue shows anything.

Two kinds of assertion, and the second is the reason this file is worth having.

The first kind is the script's own contract: ids are deterministic and prefixed, `--dry-run` writes
nothing at all, a re-run is a genuine no-op rather than one that happens to overwrite identical values,
and `--delete` can only ever address ids it built.

The second kind runs the REAL Tier-1 code over the seeded items — `backend.tier1.engine.reconcile`
with the rule table the stream consumer actually uses, and `backend.tier1.gl_match.gl_lookup` against
rows parsed out of `data/general-ledger/gl-entries.csv` — and asserts each item reaches the state the
script's own report promises. Without that, the report is prose: an item could silently stop
auto-clearing, or cite a borrower the mocked ledger has never heard of, and every test here would still
pass while the demo showed six identical PENDING cases.

The DynamoDB table is moto, through `tests/fakes/ddb.py`'s `make_table` like the rest of the repo.
Nothing here talks to AWS.
"""

import csv
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.schema import ReconItem
from backend.tier1.engine import ESCALATION_SIDE_COUNT, reconcile
from backend.tier1.gl_match import gl_lookup
from backend.tier1.handler import _RULES
from scripts.seed_recon_demo_items import (
    CATEGORY_GL_MATCH,
    CATEGORY_RULE_MATCH,
    DEMO_ITEMS,
    DOMAIN,
    ID_PREFIX,
    SCENARIOS,
    STATUS_AUTO_CLEARED,
    STATUS_PENDING,
    _demo_items,
    delete_item,
    main,
    resolve_items_table,
    select_items,
)
from tests.fakes.ddb import make_table

REPO_ROOT = Path(__file__).resolve().parents[2]
LEDGER_CSV = REPO_ROOT / "data" / "general-ledger" / "gl-entries.csv"
NOTICE_GENERATOR = REPO_ROOT / "scripts" / "generate_input_notices.py"

TABLE_NAME = "recon-items-seed-test"
REGION = "us-east-1"


def _by_scenario(scenario: str):
    """The demonstration item with this scenario handle.

    :param scenario: the handle, as ``--scenario`` accepts it.
    :returns: the DemoItem entry.
    """
    return next(demo for demo in DEMO_ITEMS if demo.scenario == scenario)


def _ledger_rows() -> list[dict]:
    """The mocked ledger, as the gl-query Lambda hands it to Tier-1.

    Every value is a string: the Lambda reads Athena's `GetQueryResults`, whose cells are all
    `VarCharValue`, so a test that returned typed values would be testing a shape production never
    produces.

    :returns: every row in ``data/general-ledger/gl-entries.csv``.
    """
    with LEDGER_CSV.open(newline="", encoding="utf-8") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def _ledger_invoker(payload: dict) -> dict:
    """Stand in for the gl-query Lambda, filtering the real CSV the way its SQL does.

    `build_query` in `backend/gl_tool/handler.py` renders the borrower filter as
    `upper(borrower) LIKE '%<value>%'` — a case-insensitive SUBSTRING match, not equality — so this
    mirrors that. Getting it wrong in either direction would make the ambiguity assertions below
    meaningless: equality would return fewer rows than production, and no filter at all would return
    every borrower's.

    :param payload: the query, as `gl_lookup`/`fetch_candidates` build it.
    :returns: ``{"rows": [...], "count": n}``.
    """
    wanted = str(payload.get("borrower") or "").upper()
    rows = [row for row in _ledger_rows() if wanted in row["borrower"].upper()]
    limit = int(payload.get("limit") or 25)
    return {"rows": rows[:limit], "count": len(rows[:limit])}


# --- the item set --------------------------------------------------------------------------------


def test_every_seeded_row_validates_against_the_shipped_model() -> None:
    """A row intake would have rejected is a demo that proves nothing.

    Re-validating the dumped form, not just the constructed object, is the part that matters: the dump
    is what `put_item` writes and what the stream consumer feeds back through
    `ReconItem.model_validate`, so a shape that only survives construction would fail inside Tier-1.
    """
    for demo in DEMO_ITEMS:
        restored = ReconItem.model_validate(demo.item.model_dump())
        assert restored == demo.item, demo.scenario


def test_ids_are_deterministic_prefixed_and_unique() -> None:
    """Determinism IS the idempotency: a clock or a uuid in an id would duplicate on every run."""
    first = [demo.item.item_id for demo in _demo_items()]
    second = [demo.item.item_id for demo in _demo_items()]
    assert first == second
    assert first == [demo.item.item_id for demo in DEMO_ITEMS]
    assert len(set(first)) == len(first)
    for item_id in first:
        assert item_id.startswith(ID_PREFIX), item_id
    # The ordinal is part of the id, so the report order and the ids cannot drift apart.
    assert first[0] == f"{ID_PREFIX}01-{SCENARIOS[0]}"
    assert first[-1] == f"{ID_PREFIX}0{len(first)}-{SCENARIOS[-1]}"


def test_no_float_reaches_the_written_row() -> None:
    """boto3's DynamoDB resource raises TypeError on a Python float, mid-run and per item.

    Every amount here is therefore a string, which is also what `ReconSide.attributes` requires and
    what `gl_match._walk_amounts` parses.
    """

    def walk(node, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")
        else:
            assert not isinstance(node, float), path

    for demo in DEMO_ITEMS:
        walk(demo.item.model_dump(), demo.scenario)


def test_every_item_is_in_the_one_domain_tier1_has_a_rule_for() -> None:
    """An item in any other domain escalates as `no_rule` and demonstrates nothing about matching."""
    assert DOMAIN in _RULES
    for demo in DEMO_ITEMS:
        assert demo.item.domain == DOMAIN, demo.scenario


def test_the_rule_category_matches_the_stream_consumer_s_rule_table() -> None:
    """The script's copy of the auto-clear category has to equal the one the handler writes.

    Drift here is invisible in the worst way: the console would show a category this script's report
    never mentions, and nothing would fail.
    """
    assert CATEGORY_RULE_MATCH == _RULES[DOMAIN]["category"]


def test_every_counterparty_is_a_borrower_the_mocked_ledger_actually_holds() -> None:
    """An item citing a borrower absent from the ledger cannot demonstrate a ledger lookup.

    It also cannot demonstrate the agent's investigation: `search_ledger` would return nothing and the
    case would escalate for a reason the scenario did not intend.
    """
    borrowers = {row["borrower"] for row in _ledger_rows()}
    for demo in DEMO_ITEMS:
        idp_attributes = demo.item.attributes.get("idp_attributes") or {}
        named = demo.item.attributes.get("counterparty") or idp_attributes.get("BorrowerName")
        assert named in borrowers, f"{demo.scenario}: {named!r} is not in the mocked ledger"


def test_every_cited_ledger_entry_exists() -> None:
    """The report tells an operator which ledger row backs each item; a dangling id misleads them."""
    entry_ids = {row["entry_id"] for row in _ledger_rows()}
    for demo in DEMO_ITEMS:
        for cited in demo.ledger_entry.split(" + "):
            assert cited in entry_ids, f"{demo.scenario}: {cited}"


def test_the_agent_bank_is_the_fictional_one_the_notice_corpus_prints() -> None:
    """The two apps have to read as ONE sample, and no name here may be a real institution.

    Asserted against the notice generator rather than against a literal, because that file is where
    the corpus's fictional agent bank is defined.
    """
    printed = NOTICE_GENERATOR.read_text(encoding="utf-8")
    for demo in DEMO_ITEMS:
        idp_attributes = demo.item.attributes.get("idp_attributes") or {}
        bank = demo.item.attributes.get("agent_bank") or idp_attributes.get("agent_bank")
        assert bank, demo.scenario
        assert bank in printed, f"{demo.scenario}: {bank!r} is not a name this repo's corpus uses"


def test_the_set_covers_both_auto_clear_paths_and_four_distinct_escalations() -> None:
    """The point of the set is visibly different states, not six rows.

    Lose the ledger auto-clear and nothing exercises `gl_lookup`; collapse two escalation reasons and
    the case screens stop being distinguishable, which is the failure mode a seeder is most likely to
    drift into.
    """
    auto_cleared = {d.expect_detail for d in DEMO_ITEMS if d.expect_status == STATUS_AUTO_CLEARED}
    escalated = [d.expect_detail for d in DEMO_ITEMS if d.expect_status == STATUS_PENDING]
    assert auto_cleared == {CATEGORY_RULE_MATCH, CATEGORY_GL_MATCH}
    assert len(escalated) == len(set(escalated)) == 4


# --- what Tier-1 actually does with them ---------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    [d.scenario for d in DEMO_ITEMS if d.item.sides],
)
def test_two_sided_items_reach_the_state_the_report_promises(scenario: str) -> None:
    """Run the real engine with the real rule table, rather than trusting the expectation text."""
    demo = _by_scenario(scenario)
    result = reconcile(demo.item, rules=_RULES)
    if demo.expect_status == STATUS_AUTO_CLEARED:
        assert result.resolved is True
        assert result.category == demo.expect_detail
        # The handler refuses to open an auto-cleared case without this evidence.
        assert result.match is not None
    else:
        assert result.resolved is False
        assert result.escalation_reason == demo.expect_detail


@pytest.mark.parametrize(
    "scenario",
    [d.scenario for d in DEMO_ITEMS if not d.item.sides],
)
def test_the_sides_less_items_are_decided_by_the_ledger_and_not_by_the_rule(scenario: str) -> None:
    """The rule cannot see a sides-less item, which is why the handler falls through to the ledger."""
    result = reconcile(_by_scenario(scenario).item, rules=_RULES)
    assert result.resolved is False
    assert result.escalation_reason == ESCALATION_SIDE_COUNT


def test_the_unambiguous_ledger_item_clears_on_exactly_one_real_row() -> None:
    """`gl_lookup` auto-clears only on a UNIQUE surviving row, so 'a row exists' is not enough."""
    demo = _by_scenario("ledger-match")
    match = gl_lookup(demo.item, invoker=_ledger_invoker)
    assert match.reason is None
    assert match.row is not None
    assert match.row["entry_id"] == demo.ledger_entry
    assert match.match is not None
    # The fund-level share settled it, never the facility-wide total the item also carries.
    assert match.match["extracted_amount"] == "618750.0"
    assert match.match["entry_type"] == "CREDIT"


def test_the_consolidated_wire_is_ambiguous_against_the_real_ledger() -> None:
    """Two rows within tolerance under one wire: the deterministic tier must refuse to choose.

    This is the assertion that keeps the scenario honest. Change either component amount to one the
    ledger does not hold and the item silently becomes a `gl_zero` — a completely different case for
    the agent to investigate, and the report would still claim ambiguity.
    """
    demo = _by_scenario("ledger-ambiguous")
    match = gl_lookup(demo.item, invoker=_ledger_invoker)
    assert match.row is None
    assert match.reason == demo.expect_detail
    # Both components really are ledger rows; the ambiguity is aggregation, not absent data.
    rows = _ledger_invoker({"borrower": demo.item.attributes["idp_attributes"]["BorrowerName"]})
    amounts = {row["amount"] for row in rows["rows"]}
    assert {"9640.18", "12500.00"} <= amounts


# --- resolving the table and selecting scenarios -------------------------------------------------


def test_the_table_comes_from_the_terraform_output() -> None:
    """The zero-argument case: a deployment that renamed its prefix is followed without being told."""
    outputs = {"items_table": {"value": "recon-prod-items", "sensitive": False}}
    assert resolve_items_table(outputs=outputs, items_table=None) == "recon-prod-items"


def test_an_explicit_table_wins_over_the_output() -> None:
    """A clone with no state, a second deployment and a moto table all arrive this way."""
    outputs = {"items_table": {"value": "recon-prod-items", "sensitive": False}}
    assert resolve_items_table(outputs=outputs, items_table="other-items") == "other-items"


def test_no_table_anywhere_names_both_the_missing_output_and_the_flag() -> None:
    """The recon root does not re-export `items_table`, so the message has to offer the flag."""
    with pytest.raises(ValueError, match="items_table"):
        resolve_items_table(outputs={}, items_table=None)
    with pytest.raises(ValueError, match="--items-table"):
        resolve_items_table(outputs=None, items_table="   ")


def test_scenario_selection_is_report_ordered_whatever_order_it_is_asked_in() -> None:
    """Two runs asking for the same set must report identically."""
    selected = select_items(scenarios=[SCENARIOS[3], SCENARIOS[0]])
    assert [d.scenario for d in selected] == [SCENARIOS[0], SCENARIOS[3]]
    assert select_items(scenarios=[]) == DEMO_ITEMS


def test_an_unknown_scenario_is_refused_by_name() -> None:
    """A typo must not silently seed nothing, which is indistinguishable from an already-seeded run."""
    with pytest.raises(ValueError, match="unknown scenario"):
        select_items(scenarios=["ledger-match", "no-such-thing"])


def test_main_exits_2_on_an_unknown_scenario() -> None:
    """Non-zero, and before any table is resolved or any client is built."""
    assert main(["--items-table", TABLE_NAME, "--scenario", "nope", "--dry-run"]) == 2


# --- main() against a moto table -----------------------------------------------------------------


@mock_aws
def test_dry_run_writes_nothing() -> None:
    """`--dry-run` reports the whole set and leaves the table empty."""
    table = make_table(TABLE_NAME, "item_id")

    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--dry-run"]) == 0

    assert table.scan()["Items"] == []


def test_dry_run_builds_no_boto3_session_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """'Touch nothing' includes not needing credentials or even a resolvable region.

    Asserted by making a session impossible rather than by checking the table afterwards: an empty
    table proves no WRITE happened, not that no client was constructed, and a `--dry-run` that dies in
    `NoRegionError` is useless to the operator deciding whether to run the real thing.
    """

    def explode(*_args, **_kwargs):
        raise AssertionError("--dry-run must not construct a boto3 session")

    monkeypatch.setattr(boto3, "Session", explode)
    assert main(["--items-table", TABLE_NAME, "--dry-run"]) == 0


@mock_aws
def test_seeding_writes_every_item_and_a_rerun_changes_nothing() -> None:
    """Re-running must neither duplicate nor fail — it is the recovery from a partial run."""
    table = make_table(TABLE_NAME, "item_id")

    assert main(["--items-table", TABLE_NAME, "--region", REGION]) == 0
    first = {row["item_id"]: row for row in table.scan()["Items"]}
    assert set(first) == {demo.item.item_id for demo in DEMO_ITEMS}

    assert main(["--items-table", TABLE_NAME, "--region", REGION]) == 0
    assert {row["item_id"]: row for row in table.scan()["Items"]} == first


@mock_aws
def test_a_seeded_row_round_trips_back_through_the_model_the_stream_consumer_uses() -> None:
    """Tier-1 rebuilds the item from the stream image with `ReconItem.model_validate`.

    A row that cannot be rebuilt does not escalate — it raises inside the stream consumer, which blocks
    every item behind it on that shard until the record ages out.
    """
    table = make_table(TABLE_NAME, "item_id")
    assert main(["--items-table", TABLE_NAME, "--region", REGION]) == 0

    for demo in DEMO_ITEMS:
        stored = table.get_item(Key={"item_id": demo.item.item_id})["Item"]
        assert ReconItem.model_validate(stored) == demo.item


@mock_aws
def test_one_scenario_at_a_time() -> None:
    """`--scenario` seeds only that item, so a single case can be replayed on its own."""
    table = make_table(TABLE_NAME, "item_id")

    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--scenario", "ledger-match"]) == 0

    assert [row["item_id"] for row in table.scan()["Items"]] == [
        _by_scenario("ledger-match").item.item_id
    ]


@mock_aws
def test_delete_removes_its_own_rows_and_leaves_every_other_row_alone() -> None:
    """The safety property of `--delete`: exact keys it built, never what a scan happened to find."""
    table = make_table(TABLE_NAME, "item_id")
    # A row this script did not write, shaped like one intake would have.
    table.put_item(Item={"item_id": "manual-scenario3-1", "domain": "cash", "sides": []})
    assert main(["--items-table", TABLE_NAME, "--region", REGION]) == 0

    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--delete"]) == 0

    assert [row["item_id"] for row in table.scan()["Items"]] == ["manual-scenario3-1"]


@mock_aws
def test_delete_is_idempotent_and_reports_the_absent_rows() -> None:
    """Deleting twice must not fail; the second run has nothing to do."""
    table = make_table(TABLE_NAME, "item_id")

    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--delete"]) == 0
    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--delete"]) == 0

    assert table.scan()["Items"] == []


@mock_aws
def test_delete_dry_run_deletes_nothing() -> None:
    """The rehearsal has to be free, or nobody rehearses."""
    table = make_table(TABLE_NAME, "item_id")
    assert main(["--items-table", TABLE_NAME, "--region", REGION]) == 0

    assert main(["--items-table", TABLE_NAME, "--region", REGION, "--delete", "--dry-run"]) == 0

    assert len(table.scan()["Items"]) == len(DEMO_ITEMS)


def test_delete_item_refuses_an_id_outside_the_prefix() -> None:
    """No table involved: the refusal happens before any call, which is why it is safe.

    A future caller that passed the wrong id — a scan result, an operator's argument — has to fail
    here rather than delete a row belonging to somebody else.
    """
    with pytest.raises(ValueError, match="refusing to delete"):
        delete_item(table=None, item_id="manual-scenario3-1")
