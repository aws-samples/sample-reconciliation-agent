"""Read one UTF-8 text object from S3, tolerating a missing key.

Prompts, skills and reference CSVs are all optional objects: an environment whose prompt was
never seeded, or whose role may read only one of two CSVs, must fall back rather than fail. What
counts as "missing" depends on the caller's grant -- a role without ``s3:ListBucket`` is told
``AccessDenied`` for a key that does not exist -- so the tolerated error codes are a parameter.
"""

import logging
from collections.abc import Collection

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# What GetObject answers for a key that does not exist when the caller may list the bucket.
MISSING_CODES: tuple[str, ...] = ("NoSuchKey", "NotFound")


def read_text(
    s3,
    bucket: str,
    key: str,
    *,
    default: str | None = None,
    tolerate_codes: Collection[str] = MISSING_CODES,
) -> str | None:
    """The object's UTF-8 text, or ``default`` when S3 answers with one of ``tolerate_codes``.

    Any other ``ClientError`` propagates: "the object is not there" and "the read failed" are
    different answers, and only the first has a safe fallback. The tolerated code is named in the
    WARNING so a permissions gap that a caller chose to tolerate as "missing" stays visible.

    :param s3: boto3 S3 client.
    :param bucket: bucket name.
    :param key: object key.
    :param default: returned when the read is tolerated as missing.
    :param tolerate_codes: botocore error codes that mean "nothing to read here". The default
        covers a key that does not exist for a caller who may list the bucket; a caller without
        ``s3:ListBucket`` also has to tolerate ``AccessDenied`` / ``403``.
    """
    try:
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code not in tolerate_codes:
            raise
        logger.warning("s3://%s/%s not read (%s); using the default", bucket, key, code)
        return default
