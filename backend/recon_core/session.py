"""Derivation of the AgentCore runtime session id.

Lives in ``recon_core`` because two dispatch paths need the identical answer: the blocking worker
(``backend/tier1/invoke_agent``) and the map run's collect step (``backend/tier2_dispatch/collect``).
Two implementations would be two chances to produce a session id AgentCore rejects, and the rejection
surfaces as a per-invocation runtime error rather than as anything resembling a naming problem.

It must NOT be reimplemented in ASL either: ``States.Format('recon-{}', item_id)`` looks equivalent and
is not — it neither sanitises the alphabet nor reaches the required length.
"""

import hashlib
import re


def session_id_for(item_id: str) -> str:
    """Derive a stable AgentCore runtime session id from the item id, at least 33 characters long.

    AgentCore requires session ids to match ``[a-zA-Z0-9][a-zA-Z0-9-_]*``, and real item ids do not:
    they carry filename characters like dots and ``#``. So the item-id portion is sanitised down to
    that alphabet, and uniqueness comes from the sha256 suffix, which is hex and therefore always
    safe. Deriving it rather than generating one keeps a redelivered item on the same session — which
    is also the "stable session id across retries" property AgentCore's own guidance asks for.

    :param item_id: the recon item id, which may contain arbitrary filename characters.
    :returns: a deterministic session id that satisfies the pattern.
    """
    safe = re.sub(r"[^a-zA-Z0-9_-]", "-", item_id)
    return f"recon-{safe}-{hashlib.sha256(item_id.encode()).hexdigest()}"[:64]
