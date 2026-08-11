"""Pytest configuration marker.

Import paths are configured in pyproject.toml (`[tool.pytest.ini_options] pythonpath`):
the repo root (for the ``backend`` package) and ``agent-blueprint/recon-agent`` (for the
top-level agent modules — agent, classifier, proposal, skills_loader — exactly as they are
imported at runtime in the deployed container).
"""
