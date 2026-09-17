"""Test doubles shared across suites.

Imported, not fixtures, so a test can build exactly the double it needs next to its assertions:

- :mod:`tests.fakes.bedrock`        a scripted ``bedrock-runtime`` Converse client, turn builders
- :mod:`tests.fakes.memory`         a canned ``bedrock-agentcore`` memory-record retrieval client
- :mod:`tests.fakes.lambda_context` a Lambda context exposing only the remaining-time budget
- :mod:`tests.fakes.ddb`            moto DynamoDB tables in the shape the handlers expect

``tests/`` is a namespace package (no ``__init__.py``; see ``consider_namespace_packages`` in
``pyproject.toml``), so ``from tests.fakes.x import y`` resolves from the repository root exactly as
``from tests.<suite>.conftest import ...`` does today.
"""
