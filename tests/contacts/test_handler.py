"""The contacts/templates gateway tool handler: no addresses out, no silent defaults."""

import pytest
from moto import mock_aws

from backend.contacts.handler import handle
from tests.contacts.conftest import CONTACTS_TABLE, TEMPLATES_TABLE


class _Context:
    """A Lambda context stand-in carrying the gateway's invoked-tool name."""

    def __init__(self, tool: str | None) -> None:
        """Build a context whose client context names ``tool``.

        :param tool: the tool name to advertise, or None for a context that names none.
        """
        self.client_context = type(
            "_CC", (), {"custom": {} if tool is None else {"bedrockAgentCoreToolName": tool}}
        )()


@mock_aws
def test_list_contacts_returns_no_email_key(monkeypatch, make_contact_tables, seed_contact) -> None:
    # The test that would catch the whole point of the workstream regressing.
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com")
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    out = handle({}, _Context("contacts___list_contacts"))
    assert out["count"] == 1
    for row in out["rows"]:
        assert "email" not in row
    assert out["rows"][0]["contact_id"] == "cp-acme"


@mock_aws
def test_a_bare_tool_name_also_dispatches(monkeypatch, make_contact_tables, seed_contact) -> None:
    # The gateway may send the name with or without its target prefix; both must land on the tool.
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com")
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    assert handle({}, _Context("list_contacts"))["count"] == 1


@mock_aws
def test_list_contacts_passes_the_kind_filter_through(
    monkeypatch, make_contact_tables, seed_contact
) -> None:
    make_contact_tables()
    seed_contact("cp-acme", email="a@acme.example.com", kind="counterparty")
    seed_contact("notify-primary", email="b@internal.example.com", kind="internal_notification")
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    out = handle({"kind": "internal_notification"}, _Context("contacts___list_contacts"))
    assert [r["contact_id"] for r in out["rows"]] == ["notify-primary"]


@mock_aws
def test_list_templates_returns_no_body_key(
    monkeypatch, make_contact_tables, seed_template
) -> None:
    make_contact_tables()
    seed_template("tpl-unmatched")
    monkeypatch.setenv("TEMPLATES_TABLE", TEMPLATES_TABLE)
    out = handle({}, _Context("templates___list_templates"))
    assert out["count"] == 1
    for row in out["rows"]:
        assert "body_template" not in row
        assert "subject_template" not in row


@mock_aws
def test_an_empty_table_reads_as_a_successful_empty_result(
    monkeypatch, make_contact_tables
) -> None:
    # "Read the table, nobody active there" is a real answer and must not raise. Only a failed read
    # raises, which is what keeps the two distinguishable.
    make_contact_tables()
    monkeypatch.setenv("CONTACTS_TABLE", CONTACTS_TABLE)
    assert handle({}, _Context("contacts___list_contacts")) == {"rows": [], "count": 0}


def test_an_unset_table_env_var_raises(monkeypatch) -> None:
    # Not a silent empty result: an unset table name would otherwise report "no recipients
    # configured", sending an operator to add a contact that is already there.
    monkeypatch.delenv("CONTACTS_TABLE", raising=False)
    with pytest.raises(KeyError, match="CONTACTS_TABLE"):
        handle({}, _Context("contacts___list_contacts"))


def test_an_unknown_tool_name_raises() -> None:
    # Must not fall through to one of the two tools.
    with pytest.raises(ValueError, match="unknown tool"):
        handle({}, _Context("contacts___delete_contact"))


def test_an_absent_tool_name_raises() -> None:
    with pytest.raises(ValueError, match="bedrockAgentCoreToolName"):
        handle({}, _Context(None))
