"""Reader for IDP's processed output in S3.

At ingest the recon hook enriches a ReconItem with the document's classification, extracted
field values, and page-image locations. The IDP completion event only carries S3 *pointers*
(``OutputJSONUri`` per section), so the values themselves must be read from IDP's output bucket.

The layout is deterministic (verified against a real IDP run):

    <input_key>/sections/<N>/result.json   -> { document_class:{type}, inference_result:{...},
                                                explainability_info:[{field:{confidence, ...}}] }
    <input_key>/pages/<N>/image.jpg         -> page preview image

``document_class`` carries a ``type`` but (in every live recon-dev output) no ``confidence``, so
the per-section confidence recon needs is aggregated from ``explainability_info`` instead — see
``explainability.py``.

This is the single sanctioned read of IDP storage (the user approved embedding extracted values
at ingest). Everything else stays decoupled: the recon runtime/agent never reads IDP S3.
"""

import json
from decimal import Decimal
from typing import Optional

import boto3

from backend.idp_hook.explainability import (
    below_threshold_count,
    field_confidences,
    mean_confidence,
)
from backend.idp_hook.mapper import split_s3_uri


def _page_num(key: str, marker: str) -> int:
    """Extract the numeric page/section id from a key like '<doc>/pages/3/image.jpg'.

    :param key: the full S3 object key.
    :param marker: the path segment preceding the number ('pages' or 'sections').
    :returns: the integer id, or a large sentinel so unparseable keys sort last.
    """
    parts = key.split("/")
    if marker in parts:
        idx = parts.index(marker)
        if idx + 1 < len(parts) and parts[idx + 1].isdigit():
            return int(parts[idx + 1])
    return 10**9


class IdpOutputReader:
    """Reads section results and page-image locations from IDP's output bucket."""

    def __init__(self, *, s3=None) -> None:
        """:param s3: optional boto3 S3 client (injected in tests); defaults to a real client."""
        self._s3 = s3 if s3 is not None else boto3.client("s3")

    def resolve_document(self, document: dict) -> dict:
        """Follow IDP's compressed-output pointer, returning the full tracking record.

        A Step Functions execution's output is capped at 256 KB, so for any document large enough
        IDP writes the real record to its WORKING bucket and puts a stand-in in the event instead::

            {"document_id": "<prefix>/<file>.pdf", "compressed": true, "num_pages": 6,
             "status": "EVALUATING", "sections": ["1", "2"],
             "s3_uri": "s3://<working>/compressed_documents/<document_id>/<ts>_evaluation_state.json"}

        Two traps make this worth a dedicated method rather than an inline branch:

        * ``sections`` degrades from a list of RECORDS to a list of id STRINGS, so code that treats
          the stand-in as the record raises ``AttributeError`` rather than merely losing detail.
        * the stand-in carries no ``output_bucket``/``input_key``, so the enrichment read is silently
          skipped (``_derive_output_location`` returns an empty bucket) — an extraction with no field
          values at all, which then fails the notice_date check for a reason that names neither cause.

        Every succeeded execution in recon-dev's IDP deployment is compressed, so this is the normal
        path and not an edge case.

        :param document: the record from the completion event's ``detail.output``.
        :returns: the resolved record when ``compressed`` is set, otherwise ``document`` unchanged.
        :raises ValueError: when the record claims to be compressed but carries no usable ``s3_uri``,
            or when the pointer's contents are not a JSON object. Deliberately loud: continuing with
            the stand-in produces a fieldless notice, which is worse than a DLQ'd invocation.
        :raises botocore.exceptions.ClientError: when the pointer cannot be read (e.g. the hook's
            role lacks a grant on IDP's working bucket) — surfaced for the same reason.
        """
        if not document.get("compressed"):
            return document
        bucket, key = split_s3_uri(document.get("s3_uri") or "")
        if not bucket or not key:
            raise ValueError(
                f"IDP document {document.get('document_id')!r} is marked compressed but has no "
                f"usable s3_uri: {document.get('s3_uri')!r}"
            )
        body = self._s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        resolved = json.loads(body)
        if not isinstance(resolved, dict):
            raise ValueError(f"compressed IDP record s3://{bucket}/{key} is not a JSON object")
        return resolved

    def read(self, *, bucket: str, prefix: str) -> dict:
        """Read all section results and page images for one processed document.

        :param bucket: IDP output bucket (e.g. 'idp-unified-output-xxxx').
        :param prefix: the document's object key / folder (e.g. 'Notice.pdf'); no trailing slash.
        :returns: dict with ``sections`` (classification + extracted ``fields`` per section) and
            ``pages`` (page id, class, image s3 uri). Floats are converted to Decimal for
            DynamoDB safety.
        :raises: botocore ClientError on an S3 failure — surfaced so the hook fails loudly.
        """
        base = prefix.rstrip("/")
        sections = self._read_sections(bucket=bucket, base=base)
        pages = self._read_pages(bucket=bucket, base=base)
        return json.loads(json.dumps({"sections": sections, "pages": pages}), parse_float=Decimal)

    def _list_keys(self, *, bucket: str, prefix: str) -> list[str]:
        """List every object key under a prefix, following pagination."""
        keys: list[str] = []
        token: Optional[str] = None
        while True:
            kwargs = {"Bucket": bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._s3.list_objects_v2(**kwargs)
            keys.extend(obj["Key"] for obj in resp.get("Contents", []))
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
        return keys

    def _read_sections(self, *, bucket: str, base: str) -> list[dict]:
        """Read each ``sections/<N>/result.json`` into a classification + fields record."""
        keys = [
            k
            for k in self._list_keys(bucket=bucket, prefix=f"{base}/sections/")
            if k.endswith("/result.json")
        ]
        keys.sort(key=lambda k: _page_num(k, "sections"))
        out = []
        for key in keys:
            body = self._s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            data = json.loads(body)
            doc_class = data.get("document_class") or {}
            inference_result = data.get("inference_result", {})
            explainability = data.get("explainability_info")
            rec = {
                "section_id": str(_page_num(key, "sections")),
                "classification": doc_class.get("type"),
                "page_indices": (data.get("split_document") or {}).get("page_indices", []),
                "fields": inference_result,
                "output_uri": f"s3://{bucket}/{key}",
            }
            # Flatten ONCE, rather than once per consumer: both aggregates below reduce these same
            # records, and the records themselves are kept and stored on the notice so the Documents
            # tab can render what was read without calling back into the pipeline.
            records = field_confidences(
                explainability_info=explainability, inference_result=inference_result
            )
            rec["field_confidences"] = records
            # IDP's confidence in the EXTRACTION, in preference order. It is stored as the notice's
            # `extraction_confidence` and read as a prompt hint + by the gateway interceptor. It is
            # not an input to any score. Preference order:
            #   1. document_class.confidence, if IDP's Assessment step ever attaches one. It does
            #      NOT in any live recon-dev output — every document_class is just {"type": ...} —
            #      so this branch is kept for forward compatibility, not because it fires.
            #   2. the mean per-field extraction confidence from explainability_info, over the
            #      fields IDP actually extracted a value for (see explainability.py for why the
            #      "extracted only" restriction is load-bearing).
            # Neither available => the key is omitted entirely rather than defaulted, so the notice
            # records `extraction_confidence: None` instead of a fabricated number.
            if doc_class.get("confidence") is not None:
                rec["classification_confidence"] = doc_class["confidence"]
            else:
                derived = mean_confidence(records)
                if derived is not None:
                    rec["classification_confidence"] = derived
            # Count of extracted fields IDP scored below their OWN confidence_threshold. Derived
            # here rather than read off the event, whose ConfidenceAlertCount field is absent in
            # practice — and an absent count leaves the downstream penalty inert. Always present
            # (0 is meaningful: "checked, nothing flagged").
            rec["confidence_alert_count"] = below_threshold_count(records)
            out.append(rec)
        return out

    def _read_pages(self, *, bucket: str, base: str) -> list[dict]:
        """List ``pages/<N>/image.jpg`` into page-preview records (id + image s3 uri)."""
        keys = [
            k
            for k in self._list_keys(bucket=bucket, prefix=f"{base}/pages/")
            if k.endswith("/image.jpg")
        ]
        keys.sort(key=lambda k: _page_num(k, "pages"))
        return [
            {"page_id": str(_page_num(k, "pages")), "image_uri": f"s3://{bucket}/{k}"}
            for k in keys
        ]

    def copy_pages(self, pages: list[dict], *, dest_bucket: str, item_id: str) -> list[dict]:
        """Copy each page image into recon's own assets bucket; return pages with local_key.

        The UI serves previews same-origin from recon's bucket, so the runtime never reads
        IDP storage. A copy failure degrades gracefully (page kept, no local_key) — previews
        are a nicety, the ingest must not fail on them.

        :param pages: page records from :meth:`read` (page_id + image_uri).
        :param dest_bucket: recon assets bucket to copy into.
        :param item_id: recon item id, used as the key namespace.
        :returns: the same page records, each with ``local_key`` when the copy succeeded.
        """
        out = []
        for page in pages:
            src_bucket, src_key = page["image_uri"][len("s3://") :].split("/", 1)
            local_key = f"idp-pages/{item_id}/page-{page['page_id']}.jpg"
            try:
                self._s3.copy_object(
                    Bucket=dest_bucket,
                    Key=local_key,
                    CopySource={"Bucket": src_bucket, "Key": src_key},
                    ContentType="image/jpeg",
                    MetadataDirective="REPLACE",
                )
                out.append({**page, "local_key": local_key})
            except Exception:  # noqa: BLE001 - previews are best-effort, never fail ingest
                out.append(dict(page))
        return out
