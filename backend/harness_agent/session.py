"""Runtime session id parsing for the harness path.

Session ids are DERIVED from the item id (never random), so the item id can be parsed back out
of them — which is what the evaluations track needs, because a session span carries only
``session.id``. This module holds the single regex that does it, and it must stay in lockstep
with the two places that BUILD a session id:

1. ``backend/tier1/invoke_agent.py::_session_id`` — the normal path, and the shape of almost
   every real session::

       recon-<sanitised item_id>-<sha256 hex of the RAW item id>     truncated to 64 chars

   There is NO attempt segment, and the ``[:64]`` truncation leaves the hex as a FRAGMENT of
   arbitrary length (6 characters in production for a typical IDP-derived item id).

2. ``chatbot-app/frontend/src/app/api/recon/cases/[id]/route.ts`` — the console's retry and
   reprocess actions::

       recon-<sanitised item_id>-retry-<epoch millis>
       recon-<sanitised item_id>-reprocess-<count>

   both right-padded with ``'0'`` to the 33-character minimum, so the trailing segment stays
   digits-only.

``<sanitised item_id>`` is the raw item id with every character outside ``[a-zA-Z0-9_-]``
replaced by ``-`` (AgentCore forbids the rest, and real item ids carry filename characters like
dots). That is IRREVERSIBLE — ``idp-Notice.pdf`` and ``idp-Notice-pdf`` sanitise to the same
string — so this parser recovers the SANITISED item id and nothing more. Callers must compare on
the sanitised side (see ``backend/eval_agreement/handler.py::_decision_lessons``, which sanitises
each lessons row before comparing) rather than trying to reverse it.

⚠️ TRUNCATION. ``[:64]`` bounds what is recoverable:

* a sanitised item id of at most **56** characters always round-trips exactly (``recon-`` + id +
  ``-`` + at least one hex character fits in 64);
* a longer one is cut by the generator, and there is no way to tell a cut id from a complete one
  — the length arithmetic is identical either way. The parser then returns either ``None`` or a
  PREFIX of the sanitised item id. It never returns a *different* item id, and since the
  evaluator matches by exact string equality against the full sanitised lesson id, a prefix
  matches nothing and the session abstains. Abstaining is the deliberate direction to fail in:
  a partial item id that happened to score some other case would be silently wrong.

Sessions are FRESH per investigation attempt (the hash/counter differs), so each run re-fetches
the latest admin-edited skills and system prompt.
"""

import re

# The console's retry/reprocess shape. Tried FIRST because its trailing counter is digits-only
# and digits are also hex, so the hashed regex below would otherwise swallow ``-retry-`` /
# ``-reprocess-`` into the item id. Greedy ``.+`` anchors on the LAST such marker.
_RERUN_RE = re.compile(r"^recon-(?P<item_id>.+)-(?:retry|reprocess)-[0-9]+$")

# The normal (Tier-1) shape: a sanitised item id then a sha256 hex fragment. The item id may
# contain hyphens and the hex fragment may not, so the LAST hyphen is always the separator —
# which is exactly what greedy ``.+`` followed by a hex-only, hyphen-free tail selects. The
# fragment is 1..64 characters because of the ``[:64]`` truncation, so no minimum can be
# required (production ids routinely carry only 6).
_HASHED_RE = re.compile(r"^recon-(?P<item_id>.+)-(?P<hash>[0-9a-fA-F]{1,64})$")


def item_id_from_session(session_id: str) -> str | None:
    """Parse the SANITISED item id back out of a session id, or None if the shape does not match.

    :param session_id: the AgentCore runtime session id.
    :returns: the sanitised item id (compare it against sanitised candidates, never against a
        raw item id), or None when the id is not a recon session id.
    """
    for pattern in (_RERUN_RE, _HASHED_RE):
        match = pattern.match(session_id or "")
        if match:
            return match.group("item_id")
    return None
