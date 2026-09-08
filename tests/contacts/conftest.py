"""Shared fixtures for the contact/template store tests (exposed as pytest fixtures, not imports)."""

import boto3
import pytest

CONTACTS_TABLE = "recon-contacts"
TEMPLATES_TABLE = "recon-email-templates"


def _make_contact_tables() -> None:
    """Create both operator-owned tables as the Terraform module defines them.

    Neither table has a stream. A stream is what makes a table case-creating in this system, and an
    operator editing a recipient must never open a recon case.

    :returns: None.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName=CONTACTS_TABLE,
        KeySchema=[{"AttributeName": "contact_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "contact_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName=TEMPLATES_TABLE,
        KeySchema=[{"AttributeName": "template_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "template_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _seed_contact(
    contact_id: str,
    *,
    email: str,
    kind: str = "counterparty",
    active: bool = True,
    display_name: str | None = None,
) -> None:
    """Write one contact row directly, bypassing the store's validation.

    Direct writes on purpose: several tests need a row the store's own ``put`` would refuse (an
    unknown ``kind``, say), and a fixture that could only produce valid rows could not drive the
    store's fail-closed paths.

    :param contact_id: partition key.
    :param email: the address the store resolves to.
    :param kind: ``counterparty`` or ``internal_notification``.
    :param active: False models a soft delete.
    :param display_name: shown to the analyst; defaults to the id.
    :returns: None.
    """
    boto3.resource("dynamodb", region_name="us-east-1").Table(CONTACTS_TABLE).put_item(
        Item={
            "contact_id": contact_id,
            "display_name": display_name or contact_id,
            "email": email,
            "kind": kind,
            "active": active,
            "created_by": "seed",
            "created_at": "2026-09-01T00:00:00",
            "updated_by": "seed",
            "updated_at": "2026-09-01T00:00:00",
        }
    )


def _seed_template(
    template_id: str,
    *,
    purpose: str = "counterparty",
    active: bool = True,
    subject_template: str = "Unmatched wire {{reference}}",
    body_template: str = "Hi {{name}}, we cannot match {{reference}}.",
    variables: tuple[str, ...] = ("name", "reference"),
) -> None:
    """Write one template row directly, bypassing the store's save-time validation.

    :param template_id: partition key.
    :param purpose: ``counterparty`` or ``internal_notification``.
    :param active: False models a soft delete.
    :param subject_template: raw subject with ``{{placeholders}}``.
    :param body_template: raw body with ``{{placeholders}}``.
    :param variables: the declared variable names.
    :returns: None.
    """
    boto3.resource("dynamodb", region_name="us-east-1").Table(TEMPLATES_TABLE).put_item(
        Item={
            "template_id": template_id,
            "name": template_id,
            "purpose": purpose,
            "subject_template": subject_template,
            "body_template": body_template,
            "variables": list(variables),
            "active": active,
            "revision": 0,
            "created_by": "seed",
            "created_at": "2026-09-01T00:00:00",
            "updated_by": "seed",
            "updated_at": "2026-09-01T00:00:00",
        }
    )


@pytest.fixture
def make_contact_tables():
    """Return the table-creation helper (call inside a moto context)."""
    return _make_contact_tables


@pytest.fixture
def seed_contact():
    """Return the contact-seeding helper (call inside a moto context)."""
    return _seed_contact


@pytest.fixture
def seed_template():
    """Return the template-seeding helper (call inside a moto context)."""
    return _seed_template
