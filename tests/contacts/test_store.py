"""ContactStore/TemplateStore: the agent-facing read never carries an address, and resolution
fails closed on an empty table, an inactive contact, or the wrong kind."""

import pytest
from moto import mock_aws

from backend.contacts.store import AGENT_CONTACT_KEYS, ContactStore, TemplateStore
from tests.contacts.conftest import CONTACTS_TABLE, TEMPLATES_TABLE


# --- ContactStore, the agent-facing read ----------------------------------------------------------


@mock_aws
def test_list_for_agent_omits_the_email_address(make_contact_tables, seed_contact) -> None:
    # The whole point of the workstream: the model can name a recipient without ever holding one.
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com")
    rows = ContactStore(table=CONTACTS_TABLE).list_for_agent()
    assert len(rows) == 1
    assert set(rows[0]) == set(AGENT_CONTACT_KEYS)
    assert "email" not in rows[0]


@mock_aws
def test_list_for_agent_omits_inactive_contacts(make_contact_tables, seed_contact) -> None:
    make_contact_tables()
    seed_contact("cp-live", email="a@acme.example.com")
    seed_contact("cp-gone", email="b@acme.example.com", active=False)
    ids = {r["contact_id"] for r in ContactStore(table=CONTACTS_TABLE).list_for_agent()}
    assert ids == {"cp-live"}


@mock_aws
def test_list_for_agent_filters_by_kind(make_contact_tables, seed_contact) -> None:
    make_contact_tables()
    seed_contact("cp-acme", email="a@acme.example.com", kind="counterparty")
    seed_contact("notify-primary", email="ops@internal.example.com", kind="internal_notification")
    rows = ContactStore(table=CONTACTS_TABLE).list_for_agent(kind="internal_notification")
    assert [r["contact_id"] for r in rows] == ["notify-primary"]


# --- ContactStore.resolve_address, the only method that returns an address -------------------------


@mock_aws
def test_resolve_address_returns_the_email_for_an_active_contact_of_the_right_kind(
    make_contact_tables, seed_contact
) -> None:
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com", kind="counterparty")
    got = ContactStore(table=CONTACTS_TABLE).resolve_address(
        contact_id="cp-acme", kind="counterparty"
    )
    assert got == "ops@acme.example.com"


@mock_aws
def test_resolve_address_raises_for_an_inactive_contact(make_contact_tables, seed_contact) -> None:
    # Deactivation is a revocation: it must make an already-approved draft unsendable.
    make_contact_tables()
    seed_contact("cp-gone", email="ops@acme.example.com", active=False)
    with pytest.raises(LookupError, match="cp-gone"):
        ContactStore(table=CONTACTS_TABLE).resolve_address(
            contact_id="cp-gone", kind="counterparty"
        )


@mock_aws
def test_resolve_address_raises_for_the_wrong_kind(make_contact_tables, seed_contact) -> None:
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com", kind="counterparty")
    with pytest.raises(LookupError, match="kind"):
        ContactStore(table=CONTACTS_TABLE).resolve_address(
            contact_id="cp-acme", kind="internal_notification"
        )


@mock_aws
def test_resolve_address_raises_for_an_unknown_contact_id(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(LookupError, match="cp-nope"):
        ContactStore(table=CONTACTS_TABLE).resolve_address(
            contact_id="cp-nope", kind="counterparty"
        )


@mock_aws
def test_resolve_address_raises_when_the_table_is_empty(make_contact_tables) -> None:
    # The fail-closed case the design names explicitly: an empty table refuses every send.
    make_contact_tables()
    with pytest.raises(LookupError):
        ContactStore(table=CONTACTS_TABLE).resolve_address(
            contact_id="anything", kind="internal_notification"
        )


@mock_aws
def test_the_three_refusals_are_distinguishable_in_the_message(
    make_contact_tables, seed_contact
) -> None:
    # Both callers that catch LookupError log only the exception, so anything absent from the
    # message is unrecoverable. Assert the three causes read differently.
    make_contact_tables()
    seed_contact("cp-off", email="a@acme.example.com", active=False)
    seed_contact("cp-wrong", email="b@acme.example.com", kind="counterparty")
    store = ContactStore(table=CONTACTS_TABLE)
    messages = []
    for contact_id, kind in (
        ("cp-missing", "counterparty"),
        ("cp-off", "counterparty"),
        ("cp-wrong", "internal_notification"),
    ):
        with pytest.raises(LookupError) as exc:
            store.resolve_address(contact_id=contact_id, kind=kind)
        messages.append(str(exc.value))
    assert len(set(messages)) == 3
    assert all("cp-" in m for m in messages)


# --- ContactStore, the operator-facing read and writes --------------------------------------------


@mock_aws
def test_list_all_includes_inactive_contacts_and_their_addresses(
    make_contact_tables, seed_contact
) -> None:
    make_contact_tables()
    seed_contact("cp-live", email="a@acme.example.com")
    seed_contact("cp-gone", email="b@acme.example.com", active=False)
    rows = ContactStore(table=CONTACTS_TABLE).list_all()
    assert {r["contact_id"] for r in rows} == {"cp-live", "cp-gone"}
    assert all("email" in r for r in rows)


@mock_aws
def test_put_records_the_actor_and_a_timestamp(make_contact_tables) -> None:
    make_contact_tables()
    store = ContactStore(table=CONTACTS_TABLE)
    written = store.put(
        contact={
            "contact_id": "cp-new",
            "display_name": "Acme Ops",
            "email": "ops@acme.example.com",
            "kind": "counterparty",
        },
        actor="analyst@example.com",
    )
    assert written["created_by"] == "analyst@example.com"
    assert written["updated_by"] == "analyst@example.com"
    assert written["active"] is True
    assert written["created_at"]


@mock_aws
def test_put_preserves_the_original_creator_on_update(make_contact_tables, seed_contact) -> None:
    # created_by is provenance. An edit must not rewrite who added the recipient.
    make_contact_tables()
    seed_contact("cp-acme", email="old@acme.example.com")
    written = ContactStore(table=CONTACTS_TABLE).put(
        contact={
            "contact_id": "cp-acme",
            "display_name": "Acme Ops",
            "email": "new@acme.example.com",
            "kind": "counterparty",
        },
        actor="second@example.com",
    )
    assert written["created_by"] == "seed"
    assert written["updated_by"] == "second@example.com"


@mock_aws
def test_put_rejects_an_unknown_kind(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(ValueError, match="kind"):
        ContactStore(table=CONTACTS_TABLE).put(
            contact={
                "contact_id": "cp-new",
                "display_name": "X",
                "email": "x@acme.example.com",
                "kind": "vendor",
            },
            actor="a",
        )


@mock_aws
def test_deactivate_is_a_soft_delete(make_contact_tables, seed_contact) -> None:
    # A hard delete would strand every historical draft citing the id.
    make_contact_tables()
    seed_contact("cp-acme", email="ops@acme.example.com")
    store = ContactStore(table=CONTACTS_TABLE)
    store.deactivate(contact_id="cp-acme", actor="analyst@example.com")
    rows = store.list_all()
    assert len(rows) == 1
    assert rows[0]["active"] is False
    assert rows[0]["updated_by"] == "analyst@example.com"


@mock_aws
def test_deactivate_raises_for_an_unknown_contact(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(LookupError, match="cp-nope"):
        ContactStore(table=CONTACTS_TABLE).deactivate(contact_id="cp-nope", actor="a")


# --- TemplateStore ---------------------------------------------------------------------------------


@mock_aws
def test_templates_list_for_agent_omits_the_body(make_contact_tables, seed_template) -> None:
    # The agent picks a template_id. Handing it the bytes invites it to paste a mutated copy.
    make_contact_tables()
    seed_template("tpl-unmatched")
    rows = TemplateStore(table=TEMPLATES_TABLE).list_for_agent()
    assert len(rows) == 1
    assert "body_template" not in rows[0]
    assert "subject_template" not in rows[0]
    assert rows[0]["variables"] == ["name", "reference"]


@mock_aws
def test_templates_list_for_agent_filters_by_purpose(make_contact_tables, seed_template) -> None:
    make_contact_tables()
    seed_template("tpl-cp", purpose="counterparty")
    seed_template("tpl-int", purpose="internal_notification")
    rows = TemplateStore(table=TEMPLATES_TABLE).list_for_agent(purpose="internal_notification")
    assert [r["template_id"] for r in rows] == ["tpl-int"]


@mock_aws
def test_get_template_returns_the_bodies(make_contact_tables, seed_template) -> None:
    make_contact_tables()
    seed_template("tpl-unmatched")
    tpl = TemplateStore(table=TEMPLATES_TABLE).get(template_id="tpl-unmatched")
    assert tpl["subject_template"] == "Unmatched wire {{reference}}"


@mock_aws
def test_get_template_raises_when_inactive(make_contact_tables, seed_template) -> None:
    make_contact_tables()
    seed_template("tpl-old", active=False)
    with pytest.raises(LookupError, match="tpl-old"):
        TemplateStore(table=TEMPLATES_TABLE).get(template_id="tpl-old")


@mock_aws
def test_get_template_raises_when_absent(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(LookupError, match="tpl-nope"):
        TemplateStore(table=TEMPLATES_TABLE).get(template_id="tpl-nope")


@mock_aws
def test_put_template_refuses_an_undeclared_placeholder(make_contact_tables) -> None:
    # Refused on SAVE, not on render: a bad template must not be storable at all.
    make_contact_tables()
    with pytest.raises(ValueError, match="nickname"):
        TemplateStore(table=TEMPLATES_TABLE).put(
            template={
                "template_id": "tpl-bad",
                "name": "Bad",
                "purpose": "counterparty",
                "subject_template": "Hi {{nickname}}",
                "body_template": "Hi {{name}}",
                "variables": ["name"],
            },
            actor="a",
        )


@mock_aws
def test_put_template_checks_the_body_as_well_as_the_subject(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(ValueError, match="amount"):
        TemplateStore(table=TEMPLATES_TABLE).put(
            template={
                "template_id": "tpl-bad",
                "name": "Bad",
                "purpose": "counterparty",
                "subject_template": "Hi {{name}}",
                "body_template": "Owing {{amount}}",
                "variables": ["name"],
            },
            actor="a",
        )


@mock_aws
def test_put_template_rejects_an_unknown_purpose(make_contact_tables) -> None:
    make_contact_tables()
    with pytest.raises(ValueError, match="purpose"):
        TemplateStore(table=TEMPLATES_TABLE).put(
            template={
                "template_id": "tpl-bad",
                "name": "Bad",
                "purpose": "marketing",
                "subject_template": "Hi",
                "body_template": "Hi",
                "variables": [],
            },
            actor="a",
        )


@mock_aws
def test_put_template_starts_at_revision_zero_and_increments(make_contact_tables) -> None:
    # Revision 0 on create matches build_persisted_draft's draft revisions, so the two numbers mean
    # the same thing when they appear side by side on a case.
    make_contact_tables()
    store = TemplateStore(table=TEMPLATES_TABLE)
    payload = {
        "template_id": "tpl-x",
        "name": "X",
        "purpose": "counterparty",
        "subject_template": "Hi {{name}}",
        "body_template": "Hi {{name}}",
        "variables": ["name"],
    }
    assert store.put(template=dict(payload), actor="a")["revision"] == 0
    assert store.put(template=dict(payload), actor="a")["revision"] == 1


@mock_aws
def test_deactivate_template_is_a_soft_delete(make_contact_tables, seed_template) -> None:
    make_contact_tables()
    seed_template("tpl-old")
    store = TemplateStore(table=TEMPLATES_TABLE)
    store.deactivate(template_id="tpl-old", actor="a")
    assert store.list_all()[0]["active"] is False
    assert store.list_for_agent() == []
