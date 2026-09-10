"""Tests for `--check` in scripts/push_idp_extraction_config.py.

`--check` is the drift gate: the class schemas live in the document pipeline's DynamoDB configuration
table, and the reviewed copy lives at `data/idp-extraction-config/classes.json`. Nothing else compares
them, and the two diverging fails in a way no test and no runtime error can report -- extraction reads
the schema it was given, emits fields under whatever keys that schema declares, and the hook reads three
of them by literal name. So a rename makes a notice unretrievable, and every other field arrives under a
name no reader asks for. Both look like "this notice class does not carry that field".

The exit code is the whole contract here: a CI job that runs this and ignores the status has bought
nothing, so the assertions are on the status rather than on the printed report.

Uses moto with an item shaped like the live table -- a single `Configuration` hash key, and the config
body gzipped under `_compressed_config` as a binary attribute.
"""

import gzip
import json
from typing import Any

import boto3
import pytest
from moto import mock_aws

from scripts.push_idp_extraction_config import CLASSES_KEY, CONFIG_PREFIX, main

TABLE_NAME = "idp-configuration-table-test"
CONFIG_NAME = "Recon-IDP-test"


def _make_config_table():
    """Create the moto-mocked configuration table.

    :returns: the boto3 Table resource.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    return ddb.create_table(
        TableName=TABLE_NAME,
        KeySchema=[{"AttributeName": "Configuration", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "Configuration", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _seed_config(table: Any, *, classes: list[dict]) -> None:
    """Write one configuration version whose `classes` array is the given list.

    The body is gzipped under `_compressed_config`, which is the shape the live table uses and the only
    one `read_config` accepts.

    :param table: the boto3 Table resource.
    :param classes: the class schemas to install as the live config.
    :returns: None.
    """
    body = {"_config_format": "unified", CLASSES_KEY: classes, "extraction": {"model": "x"}}
    table.put_item(
        Item={
            "Configuration": f"{CONFIG_PREFIX}{CONFIG_NAME}",
            "_config_storage": "compressed",
            "_compressed_config": gzip.compress(json.dumps(body).encode()),
            "IsActive": True,
        }
    )


def _artifact(tmp_path, *, classes: list[dict]):
    """Write a classes artifact to a temp path, canonically formatted as the real one is.

    :param tmp_path: pytest's temp directory fixture.
    :param classes: the class schemas the artifact should declare.
    :returns: the path written.
    """
    path = tmp_path / "classes.json"
    path.write_text(json.dumps(classes, indent=2, sort_keys=True, ensure_ascii=False))
    return path


def _cls(class_id: str, *properties: str) -> dict:
    """Build one minimal class schema that `load_classes` will accept.

    `x-aws-idp-document-type` must equal `$id` -- the pipeline keys the schema by one and reports the
    section's `classification` from the other, so `load_classes` rejects a mismatch. Included here rather
    than omitted, or these tests would fail in the artifact loader and never reach the drift comparison
    they are about.

    :param class_id: the `$id` the schema is keyed by.
    :param properties: the property names the class declares.
    :returns: the class schema.
    """
    return {
        "$id": class_id,
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "description": f"{class_id} description",
        "type": "object",
        "x-aws-idp-document-type": class_id,
        "properties": {name: {"type": "string", "description": name} for name in properties},
    }


def _run(table_name: str, artifact) -> int:
    """Invoke the script's `main` in check mode.

    :param table_name: the configuration table to read.
    :param artifact: path to the classes artifact.
    :returns: the process exit status `main` would produce.
    """
    return main(
        [
            "--table",
            table_name,
            "--config-name",
            CONFIG_NAME,
            "--classes",
            str(artifact),
            "--check",
        ]
    )


@mock_aws
def test_check_exits_zero_when_the_live_config_matches_the_artifact(tmp_path) -> None:
    """No drift is exit 0, so a green CI run means the deployed schemas are the reviewed ones."""
    classes = [_cls("borrowing_notice", "counterparty", "notice_date", "amount")]
    table = _make_config_table()
    _seed_config(table, classes=classes)

    assert _run(TABLE_NAME, _artifact(tmp_path, classes=classes)) == 0


@mock_aws
def test_check_exits_nonzero_when_a_field_key_differs(tmp_path) -> None:
    """The failure this gate exists for, and the one nothing else can see.

    A renamed key is not a missing field: extraction still runs and still scores well, and the value
    lands under a name no reader asks for. The hook then stores the field as ABSENT and the agent reads
    "this notice class does not carry that field" — a confident false negative rather than an error.
    """
    table = _make_config_table()
    # Deployed schema calls the index key `NoticeDate`; the reviewed artifact calls it `notice_date`.
    _seed_config(table, classes=[_cls("borrowing_notice", "counterparty", "NoticeDate")])
    artifact = _artifact(
        tmp_path, classes=[_cls("borrowing_notice", "counterparty", "notice_date")]
    )

    assert _run(TABLE_NAME, artifact) == 1


@mock_aws
def test_check_exits_nonzero_when_the_live_config_is_missing_a_class(tmp_path) -> None:
    """A class the artifact declares and the deployment does not means those documents go unclassified."""
    table = _make_config_table()
    _seed_config(table, classes=[_cls("borrowing_notice", "counterparty")])
    artifact = _artifact(
        tmp_path,
        classes=[_cls("borrowing_notice", "counterparty"), _cls("paydown_notice", "counterparty")],
    )

    assert _run(TABLE_NAME, artifact) == 1


@mock_aws
def test_check_writes_nothing_even_when_it_finds_drift(tmp_path) -> None:
    """A gate that mutated what it was inspecting could not be run from CI on a real deployment.

    Asserted on the stored bytes rather than on the absence of a backup item: a push both rewrites the
    config AND adds a `-prepush-` backup, and checking only for the backup would miss a write that
    somehow skipped it.
    """
    table = _make_config_table()
    _seed_config(table, classes=[_cls("borrowing_notice", "counterparty", "NoticeDate")])
    before = table.get_item(Key={"Configuration": f"{CONFIG_PREFIX}{CONFIG_NAME}"})["Item"]
    artifact = _artifact(
        tmp_path, classes=[_cls("borrowing_notice", "counterparty", "notice_date")]
    )

    assert _run(TABLE_NAME, artifact) == 1

    after = table.scan()["Items"]
    assert len(after) == 1, f"check mode created an item: {[i['Configuration'] for i in after]}"
    assert after[0]["_compressed_config"] == before["_compressed_config"]


@mock_aws
def test_a_missing_config_version_raises_rather_than_reporting_no_drift(tmp_path) -> None:
    """Pointing the gate at a version that does not exist must never read as "clean".

    The wrong `--config-name` is the likeliest operator error here, and reporting exit 0 for it would
    make a CI job that guards nothing look like one that guards everything. It raises rather than
    returning a status, which a shell still sees as a failure — what matters is that it is not 0.
    """
    _make_config_table()
    artifact = _artifact(tmp_path, classes=[_cls("borrowing_notice", "counterparty")])

    with pytest.raises(ValueError, match="no item"):
        _run(TABLE_NAME, artifact)
