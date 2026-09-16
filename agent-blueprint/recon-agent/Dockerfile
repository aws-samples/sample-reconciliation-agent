# Recon Agent container — arm64, Python 3.12-slim, BedrockAgentCoreApp on port 8080.
# Base pulled from ECR Public, NOT Docker Hub. CodeBuild has no Docker Hub credentials, so an
# anonymous `docker.io` pull is rate-limited per source IP and fails the build with HTTP 429 —
# which is what took down every retry attempt of recon-dev-agent-build on 2026-09-10. ECR Public
# mirrors the same official image and is unmetered from inside AWS. The frontend Dockerfile
# already does this; keep the two consistent.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Install agent deps.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the agent modules (top-level, as imported at runtime) and the shared backend package.
# ⚠️ This list must include EVERY top-level module agent.py (transitively) imports. A module missing
# here crashes the container at startup, before it can serve a single request, so keep it in sync with
# the imports. There is deliberately no IDP client module, and now no IDP tool either: the extracted
# fields live on recon's own notice row, reached through the ordinary notices gateway read.
# confidence/auto_resolve/lessons_recall live under
# backend/recon_core and arrive with the COPY below.
COPY agent.py classifier.py proposal.py skills_loader.py llm.py gateway_mcp.py strands_investigator.py ./
COPY skills ./skills
COPY backend ./backend

# Drop root (CWE-250). The agent only reads /app and makes outbound calls — it writes nothing
# to the filesystem — so there is no reason to keep root after the build steps. 8080 is an
# unprivileged port, so binding it as appuser needs no extra capability.
RUN useradd --create-home --uid 10001 appuser
USER appuser

# OTel: ADOT auto-instrumentation must run inside the container — the AgentCore platform
# does not inject it into custom runtime images. opentelemetry-instrument wires the OTLP
# exporter from the platform-provided OTEL_* env and emits the gen-ai/strands spans the
# online evaluators score; without it the agent's `spans` log stream gets nothing and only the
# platform's own AgentCore.Runtime.Invoke span is recorded (in aws/spans).
EXPOSE 8080
CMD ["opentelemetry-instrument", "python", "agent.py"]
