#!/usr/bin/env python3
"""Push `data/idp-extraction-config/classes.json` into a live IDP configuration version.

WHY THIS EXISTS. The document pipeline's extraction schema lived ONLY in that deployment's DynamoDB
configuration table. Nothing in this repo described it, so it could not be reviewed, diffed or
rebuilt -- and it drifted away from `data/input/IDP-EXTRACTION-REQUIREMENTS.md` without anything
failing. That is the shape of failure the contract itself warns about: extraction found the right
values, emitted them under different key names (`NoticeDate`, `RecipientShareAmount`,
`Borrower.BorrowerName`), and the hook reported every field as *unavailable*, which the agent reads
as "this notice class does not carry that field" rather than as a fault. The table stayed the source
of truth for what runs; this script makes the repo the source of truth for what SHOULD run, and
`tests/input_corpus/test_extraction_config.py` is what keeps the artifact honest against the
contract.

WHAT IT IS NOT. This is an OPERATOR action, run by hand against a deployment that already exists. It
is deliberately not recon Terraform and not anything the recon runtime calls: the only two channels
between the two solutions are the completion-event hook and the IDP MCP tool
(IDP-EXTRACTION-REQUIREMENTS.md §7), and a Terraform resource that wrote another team's
configuration table would be a third.

WHAT IT TOUCHES. Exactly one attribute of exactly one item: the `classes` array inside the
configuration blob. Every other section -- models, prompts, OCR backend, assessment thresholds,
pricing -- is that deployment's tuning and is read back and rewritten untouched. The item must
already exist: a configuration version cannot be created from this artifact, because the artifact
holds no models and no prompts, and a config with classes and no extraction model would look
installed while extracting nothing.

Usage:
    # See what would change. Reads the live config, writes nothing.
    python3 scripts/push_idp_extraction_config.py --table idp-configuration-table-XXXXXXXX \\
        --profile <your-profile> --region us-east-1 --dry-run

    # Push, keeping a timestamped backup of the config as it was.
    python3 scripts/push_idp_extraction_config.py --table idp-configuration-table-XXXXXXXX \\
        --profile <your-profile> --region us-east-1

⚠️ A push does NOT re-extract anything. Documents already processed keep the fields they were
extracted with, so the notice that failed to ingest before a push still has no usable date after it.
Re-upload the document (or reprocess it in the pipeline) to see the new schema take effect.

⚠️ The configuration name is the version the recon upload dialog names in
`seed_extraction_config_version`, NOT necessarily the pipeline's default. Pushing to the wrong
version succeeds and changes nothing observable, because uploads keep extracting against the version
they name. Read the version off the console's Documents tab before pushing.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import json
import sys
from pathlib import Path
from typing import Any

import boto3

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLASSES = REPO_ROOT / "data" / "idp-extraction-config" / "classes.json"

# The configuration table's single hash key, and the `Config#<name>` convention its items use. Other
# item kinds share the table (`Schema`, `DefaultPricing`, `BdaProject#<name>`), which is why the
# prefix is applied here rather than expecting the caller to pass a bare name.
KEY_ATTRIBUTE = "Configuration"
CONFIG_PREFIX = "Config#"

# The blob attribute and the marker that says the blob is gzipped JSON rather than a plain map. Both
# are the pipeline's convention: an item whose `_config_storage` is anything else is not one this
# script knows how to rewrite, and it refuses rather than guessing.
BLOB_ATTRIBUTE = "_compressed_config"
STORAGE_ATTRIBUTE = "_config_storage"
STORAGE_COMPRESSED = "compressed"

# The array this script owns. Named as a constant because the whole safety argument for the script is
# that it is the only key it writes.
CLASSES_KEY = "classes"

# JSON Schema `$id` is what the pipeline keys a class by, and it is the value that must equal the
# `classification` the platform reads. `x-aws-idp-document-type` carries the same string.
CLASS_ID_KEY = "$id"


def load_classes(*, path: Path) -> list[dict[str, Any]]:
    """Read and structurally validate the tracked classes artifact.

    Validation here is not politeness: a malformed artifact pushed into a live config produces an
    extraction that classifies nothing, and the failure surfaces days later as empty notices.

    :param path: filesystem path to the classes JSON array.
    :returns: the parsed list of class schemas.
    :raises ValueError: when the file is not a non-empty array of objects each carrying a string
        ``$id`` that matches its ``x-aws-idp-document-type``, or when two classes share an ``$id``.
    """
    classes = json.loads(path.read_text())
    if not isinstance(classes, list) or not classes:
        raise ValueError(f"{path} must hold a non-empty JSON array of class schemas")

    seen: set[str] = set()
    for index, entry in enumerate(classes):
        if not isinstance(entry, dict):
            raise ValueError(f"{path}[{index}] is {type(entry).__name__}, expected an object")
        class_id = entry.get(CLASS_ID_KEY)
        if not isinstance(class_id, str) or not class_id:
            raise ValueError(f"{path}[{index}] has no string {CLASS_ID_KEY}")
        # The two must agree: the pipeline keys the schema by `$id` but reports the section's
        # `classification` from `x-aws-idp-document-type`. Disagreeing values give a class that
        # extracts under one name and classifies under another, and the platform reads the second.
        document_type = entry.get("x-aws-idp-document-type")
        if document_type != class_id:
            raise ValueError(
                f"{path}[{index}] ({class_id}): x-aws-idp-document-type is "
                f"{document_type!r}, which must equal {CLASS_ID_KEY}"
            )
        if class_id in seen:
            raise ValueError(f"{path} declares {class_id!r} twice")
        seen.add(class_id)
        if not isinstance(entry.get("properties"), dict):
            raise ValueError(f"{path}[{index}] ({class_id}) has no properties object")

    return classes


def read_config(*, table: Any, config_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch one configuration item and decompress its blob.

    :param table: a boto3 DynamoDB ``Table`` resource for the configuration table.
    :param config_name: the configuration version name, without the ``Config#`` prefix.
    :returns: a pair of (the raw DynamoDB item, the decompressed configuration dict).
    :raises ValueError: when the item does not exist, or does not store its config compressed.
    """
    key = f"{CONFIG_PREFIX}{config_name}"
    item = table.get_item(Key={KEY_ATTRIBUTE: key}).get("Item")
    if item is None:
        raise ValueError(
            f"no item {key!r} in the configuration table -- this script rewrites an existing "
            "configuration version and cannot create one, because the artifact holds classes only "
            "(no models, no prompts)"
        )

    storage = item.get(STORAGE_ATTRIBUTE)
    if storage != STORAGE_COMPRESSED:
        raise ValueError(
            f"{key} has {STORAGE_ATTRIBUTE}={storage!r}, expected {STORAGE_COMPRESSED!r} -- this "
            "item does not store its configuration the way this script knows how to rewrite"
        )

    blob = item[BLOB_ATTRIBUTE]
    # boto3's resource layer returns a Binary wrapper; `.value` is the bytes. A str would mean the
    # attribute came back base64-encoded (the low-level client / CLI shape).
    raw = blob.value if hasattr(blob, "value") else base64.b64decode(blob)
    return item, json.loads(gzip.decompress(raw))


def describe_change(
    *,
    live: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> list[str]:
    """Summarise, per class, how the incoming classes differ from the live ones.

    Reported as lines rather than a raw diff because the interesting unit is the FIELD KEY: a class
    losing a property is a field the platform will start reporting as unavailable, and that is the
    failure mode this whole artifact exists to make visible.

    :param live: class schemas currently installed.
    :param incoming: class schemas from the tracked artifact.
    :returns: human-readable lines; empty when the two are identical.
    """
    live_by_id = {c.get(CLASS_ID_KEY): c for c in live}
    incoming_by_id = {c[CLASS_ID_KEY]: c for c in incoming}

    lines: list[str] = []
    for class_id in sorted(set(live_by_id) - set(incoming_by_id)):
        lines.append(f"  - REMOVED class {class_id}")
    for class_id in sorted(set(incoming_by_id) - set(live_by_id)):
        props = sorted(incoming_by_id[class_id]["properties"])
        lines.append(f"  + ADDED   class {class_id} ({len(props)} fields)")

    for class_id in sorted(set(live_by_id) & set(incoming_by_id)):
        before = live_by_id[class_id]
        after = incoming_by_id[class_id]
        before_props = set(before.get("properties") or {})
        after_props = set(after["properties"])
        gained = sorted(after_props - before_props)
        lost = sorted(before_props - after_props)
        # A changed description is a changed extraction instruction, so it counts as a change even
        # when the key set is identical -- most of the tuning in these schemas IS the prose.
        reworded = sorted(
            key
            for key in after_props & before_props
            if (before["properties"][key] or {}) != after["properties"][key]
        )
        described = before.get("description") != after.get("description")
        if not (gained or lost or reworded or described):
            continue
        lines.append(f"  ~ {class_id}:")
        if gained:
            lines.append(f"      + fields {gained}")
        if lost:
            lines.append(f"      - fields {lost} (the platform will report these as unavailable)")
        if reworded:
            lines.append(f"      ~ reworded {reworded}")
        if described:
            lines.append("      ~ reworded the class description (classification instruction)")
    return lines


def push(
    *,
    table: Any,
    config_name: str,
    classes: list[dict[str, Any]],
    dry_run: bool,
) -> bool:
    """Replace the `classes` array of one configuration version, backing up what was there.

    :param table: a boto3 DynamoDB ``Table`` resource for the configuration table.
    :param config_name: the configuration version name, without the ``Config#`` prefix.
    :param classes: the class schemas to install.
    :param dry_run: when true, report the change and write nothing.
    :returns: True when something was written (or would be, under ``dry_run``).
    """
    item, config = read_config(table=table, config_name=config_name)
    live_classes = config.get(CLASSES_KEY) or []

    changes = describe_change(live=live_classes, incoming=classes)
    if not changes:
        print(f"Config#{config_name}: classes already match the artifact -- nothing to push.")
        return False

    print(f"Config#{config_name}: {len(live_classes)} live class(es) -> {len(classes)} incoming")
    for line in changes:
        print(line)

    if dry_run:
        print("\n--dry-run: nothing written.")
        return True

    stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    backup_key = f"{CONFIG_PREFIX}{config_name}-prepush-{stamp}"
    # Back up FIRST, and as a byte-for-byte copy of the item rather than a re-serialisation of the
    # decompressed dict: a round trip through json could reorder or retype values, so the backup
    # would not be the thing that was running. Also marked inactive, so a backup can never be picked
    # up as a live configuration version by anything listing the table.
    backup = dict(item)
    backup[KEY_ATTRIBUTE] = backup_key
    backup["IsActive"] = False
    backup["Description"] = (
        f"Backup of {CONFIG_PREFIX}{config_name} taken before push_idp_extraction_config.py "
        f"replaced its {CLASSES_KEY} array."
    )
    table.put_item(Item=backup)
    print(f"\nBacked up the previous configuration to {backup_key}")

    config[CLASSES_KEY] = classes
    updated = dict(item)
    updated[BLOB_ATTRIBUTE] = gzip.compress(json.dumps(config, ensure_ascii=False).encode("utf-8"))
    updated["UpdatedAt"] = dt.datetime.now(dt.UTC).isoformat()
    table.put_item(Item=updated)
    print(f"Pushed {len(classes)} class(es) to {CONFIG_PREFIX}{config_name}")
    print(
        "\nAlready-processed documents keep the fields they were extracted with. Re-upload a "
        "document to exercise the new schema."
    )
    return True


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and push (or report) the classes artifact.

    :param argv: argument vector, defaulting to ``sys.argv[1:]``.
    :returns: process exit status; 0 on success.
    """
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--table",
        required=True,
        help="the document pipeline's DynamoDB configuration table, e.g. idp-configuration-table-XXXXXXXX",
    )
    parser.add_argument(
        "--config-name",
        default="Recon-IDP",
        help="configuration version to rewrite, without the Config# prefix (default: Recon-IDP)",
    )
    parser.add_argument(
        "--classes",
        type=Path,
        default=DEFAULT_CLASSES,
        help=f"path to the classes artifact (default: {DEFAULT_CLASSES.relative_to(REPO_ROOT)})",
    )
    parser.add_argument("--profile", default=None, help="AWS profile to use")
    parser.add_argument("--region", default=None, help="AWS region the configuration table is in")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report the change and write nothing",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing and EXIT NON-ZERO if the live config differs from the artifact",
    )
    args = parser.parse_args(argv)

    classes = load_classes(path=args.classes)
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    # `--check` is `--dry-run` plus an exit code, so the drift report is the SAME diff a push would
    # apply -- a second implementation could disagree with the thing it is guarding.
    drifted = push(
        table=table,
        config_name=args.config_name,
        classes=classes,
        dry_run=args.dry_run or args.check,
    )
    if args.check and drifted:
        print(
            "\nDRIFT: the deployed configuration's classes are not the reviewed artifact.\n"
            "Extraction is running against schemas nobody reviewed, and a field key that differs "
            "produces PERFECT extraction that lands nowhere: the hook reads the three index keys by "
            "literal name, so a rename makes the notice unretrievable, and every other field arrives "
            "under a name no reader asks for. See data/idp-extraction-config/README.md.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
