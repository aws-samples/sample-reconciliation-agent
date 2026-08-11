"""Ingress-gateway invocation: URL construction + SigV4 signing + transport contract."""

from backend.tier1.ingress_invoke import (
    ingress_invocation_url,
    invoke_via_ingress,
    signed_headers,
)


class _Creds:
    """Minimal static credentials botocore's SigV4Auth accepts."""

    access_key = "AKIDEXAMPLE"
    # Fake static value used only so botocore's SigV4Auth can compute a signature in-process;
    # never a real credential.
    secret_key = "SECRETKEY"  # nosec B105 - test fixture, not a real secret
    token = None


def test_invocation_url_appends_target_and_invocations():
    base = "https://recon-dev-ingress-gateway-abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com"
    assert ingress_invocation_url(base, "recon-agent") == f"{base}/recon-agent/invocations"
    # Trailing/leading slashes collapse — no doubled path separators.
    assert ingress_invocation_url(f"{base}/", "/recon-agent/") == f"{base}/recon-agent/invocations"


def test_signed_headers_include_sigv4_and_session():
    url = "https://gw.example.com/recon-agent/invocations"
    h = signed_headers(
        url=url, body=b'{"item": {}}', region="us-east-1", session_id="sess-123", creds=_Creds()
    )
    assert h["Authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert "bedrock-agentcore" in h["Authorization"]
    assert h["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"] == "sess-123"


def test_invoke_via_ingress_uses_transport_seam():
    calls = []

    def _transport(url, body, headers):
        calls.append((url, body, headers))
        return 200

    status = invoke_via_ingress(
        gateway_url="https://gw.example.com",
        target="recon-agent",
        region="us-east-1",
        payload={"item": {"item_id": "i-1"}},
        session_id="sess-123",
        creds=_Creds(),
        transport=_transport,
    )
    assert status == 200
    url, body, headers = calls[0]
    assert url == "https://gw.example.com/recon-agent/invocations"
    assert b'"item_id": "i-1"' in body
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 ")


def test_extra_headers_ride_along_without_disturbing_the_signature():
    """OTel trace headers are merged after signing, so the Authorization header is unchanged."""
    seen = {}

    def _transport(url, body, headers):
        seen.update(headers)
        return 200

    invoke_via_ingress(
        gateway_url="https://gw.example.com",
        target="recon-agent",
        region="us-east-1",
        payload={"item": {"item_id": "i-1"}},
        session_id="sess-123",
        creds=_Creds(),
        transport=_transport,
        extra_headers={"traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01",
                       "baggage": "recon.item_id=i-1"},
    )
    assert seen["traceparent"].startswith("00-")
    assert seen["baggage"] == "recon.item_id=i-1"
    # The signature covers only the headers present at signing time, so neither extra header may
    # appear in SignedHeaders — that is what makes merging them afterwards safe.
    signed = seen["Authorization"].split("SignedHeaders=")[1].split(",")[0]
    assert "traceparent" not in signed
    assert "baggage" not in signed
    # ...while the session header still IS signed (proves SignedHeaders was parsed, not empty).
    assert "x-amzn-bedrock-agentcore-runtime-session-id" in signed
