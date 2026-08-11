"""Runtime session id parsing for the harness path.

Sessions are named ``recon-<item_id>-<attempt>-<uuid>`` — a FRESH session per investigation
attempt, so each run re-fetches the latest admin-edited skills and system prompt. The evaluations
track parses ``item_id`` back out of the session id, and this is the single regex that does it.
"""

import re

# recon-<item_id>-<attempt>-<uuid>. item_id may contain hyphens, so anchor on the trailing
# -<attempt>-<uuid> (attempt = digits; uuid = hex/hyphens) and take everything before it.
_SESSION_RE = re.compile(r"^recon-(?P<item_id>.+)-(?P<attempt>\d+)-[0-9a-fA-F-]{8,}$")


def item_id_from_session(session_id: str) -> str | None:
    """Parse the item id back out of a session id, or None if it does not match the shape.

    :param session_id: the AgentCore runtime session id.
    :returns: the item id, or None when the id is not a recon session id.
    """
    m = _SESSION_RE.match(session_id or "")
    return m.group("item_id") if m else None
