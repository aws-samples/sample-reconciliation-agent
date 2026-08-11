"""Tests for the shared ReconItem/ReconSide domain schema."""

from backend.recon_core.schema import ReconItem, ReconSide


def test_recon_item_requires_two_sides_and_domain():
    """A ReconItem carries a domain, its sides, source refs, and defaults to tier 1."""
    item = ReconItem(
        item_id="i-1",
        domain="cash",
        sides=[
            ReconSide(name="bank", attributes={"amount": "100.00"}),
            ReconSide(name="ledger", attributes={"amount": "100.00"}),
        ],
        source_refs=["s3://raw/i-1"],
    )
    assert item.domain == "cash"
    assert len(item.sides) == 2
    assert item.tier == 1  # defaults to tier 1 on creation


def test_recon_item_carries_top_level_attributes():
    """The IDP hook stores idp_class / idp_attributes in a free-form top-level bag."""
    item = ReconItem(
        item_id="idp-x",
        domain="cash",
        sides=[ReconSide(name="bank"), ReconSide(name="ledger")],
        attributes={"idp_class": "InterestNotice"},
    )
    assert item.attributes["idp_class"] == "InterestNotice"
    assert ReconItem(item_id="y", domain="cash", sides=[]).attributes == {}
