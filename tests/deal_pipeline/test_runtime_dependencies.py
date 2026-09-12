"""The pipeline Lambdas import with no third-party wheel but tzdata.

The standalone deal-pipeline root (``infra/environments/deal-pipeline/main.tf``) vendors only
``tzdata``; pydantic and PyYAML exist in the recon root's zip alone. A ``recon_core`` import that
reaches ``schema`` or ``skill_meta`` would pass every moto test here (the venv has both) and fail
the Lambda at cold start, so this pins the import chain in a fresh interpreter with those modules
made unimportable.
"""

import os
import subprocess
import sys

from tests.deal_pipeline.conftest import REPO_ROOT

RECON_ONLY_WHEELS = ("pydantic", "yaml")
HANDLERS = ("backend.deal_pipeline.parser_handler", "backend.deal_pipeline.oms_upload_handler")


def test_handlers_import_without_the_recon_only_wheels():
    # sys.modules[name] = None makes ``import name`` raise ModuleNotFoundError.
    code = (
        "import sys\n"
        f"for name in {RECON_ONLY_WHEELS!r}:\n    sys.modules[name] = None\n"
        f"for name in {HANDLERS!r}:\n    __import__(name)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
