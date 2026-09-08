# Recon Agent container — arm64, Python 3.12-slim, BedrockAgentCoreApp on port 8080.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app

# Install agent deps.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the agent modules (top-level, as imported at runtime) and the shared backend package.
# NOTE: this list must include EVERY top-level module agent.py (transitively) imports. A missing
# module crashes the container at startup before it can serve a request — gateway_mcp.py was once
# dropped here and did exactly that. Keep it in sync with the imports. (idp_client.py was removed:
# IDP get_results is a gateway tool called via gateway_mcp — there is no direct IDP MCP path.)
# confidence/auto_resolve/lessons_recall now live under backend/recon_core (COPY backend below).
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
