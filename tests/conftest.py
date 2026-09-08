"""Session-wide test fixtures."""

import pytest

from backend.recon_core import skill_meta


@pytest.fixture(autouse=True)
def _clear_s3_skill_cache():
    """Drop the shared S3 skill catalog cache between tests.

    ``skill_meta._S3_CACHE`` is a module global keyed by ``bucket/prefix``, and it survives for the
    whole pytest process. Tests that seed the same ``recon-assets``/``skills/`` pair with an injected
    clock therefore read each other's catalogs — a later test asserting on its own seeded skill can
    pass against an earlier test's entry without ever calling S3. Clearing it makes each test
    exercise the real scan.
    """
    skill_meta._S3_CACHE.clear()
    yield
    skill_meta._S3_CACHE.clear()
