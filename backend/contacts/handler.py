"""The list_contacts / list_templates Gateway tools: recipients and templates, without addresses.

One Lambda serves both gateway targets. The two targets exist because AgentCore composes the exposed
tool name as ``<target-name>___<tool-name>``, and the design names the tools
``contacts___list_contacts`` and ``templates___list_templates`` — two different prefixes, so two
targets. Sharing the Lambda keeps the "never return an address" rule in one deployable.

Every read here goes through the store's agent-facing projection, so ``email`` cannot reach a caller
even if a future tool argument asks for it. There is no write tool and none is planned: giving the
agent no write tool at all is stronger than giving it one and denying it in Cedar.
"""

import os

from backend.contacts.store import ContactStore, TemplateStore

LIST_CONTACTS = "list_contacts"
LIST_TEMPLATES = "list_templates"


def _tool_name(context) -> str:
    """The bare tool name the gateway invoked, without its target prefix.

    AgentCore passes the invoked tool in the Lambda client context. Depending on the target shape it
    may arrive bare (``list_contacts``) or prefixed (``contacts___list_contacts``); both are accepted
    and the prefix is stripped. An unrecognised name still raises below — this normalises the shape,
    it does not guess the tool.

    :param context: the Lambda context object supplied by the runtime.
    :returns: the bare tool name.
    :raises ValueError: when the runtime supplied no tool name. Dispatching to a default would mean
        one of the two tools answering for the other, and the caller would never know.
    """
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    raw = custom.get("bedrockAgentCoreToolName") or ""
    if not raw:
        raise ValueError(
            "the gateway supplied no bedrockAgentCoreToolName; cannot tell which tool was invoked"
        )
    return raw.rsplit("___", 1)[-1]


def handle(event: dict, context, *, contacts=None, templates=None) -> dict[str, object]:
    """Return the operator-maintained contacts or templates, never an email address.

    :param event: tool input. ``list_contacts`` takes an optional ``kind``
        (``counterparty`` | ``internal_notification``); ``list_templates`` takes an optional
        ``purpose`` with the same two values.
    :param context: Lambda context; its client context names the invoked tool.
    :param contacts: injectable ContactStore stand-in (tests); the real store by default.
    :param templates: injectable TemplateStore stand-in (tests); the real store by default.
    :returns: ``{"rows": [...], "count": n}``. Contact rows carry exactly ``contact_id``,
        ``display_name``, ``kind`` and ``active``; template rows carry ``template_id``, ``name``,
        ``purpose``, ``variables`` and ``active``. An empty ``rows`` list means "read the table,
        nothing active there" — a read failure raises instead.
    :raises KeyError: when ``CONTACTS_TABLE`` or ``TEMPLATES_TABLE`` is unset. Read with no default
        on purpose: a default would scan a table named ``""`` and report an empty recipient list,
        which reads identically to an operator who has not added anyone yet.
    :raises ValueError: on an unknown or absent tool name.
    """
    tool = _tool_name(context)
    if tool == LIST_CONTACTS:
        store = contacts or ContactStore(table=os.environ["CONTACTS_TABLE"])
        rows = store.list_for_agent(kind=event.get("kind") or None)
    elif tool == LIST_TEMPLATES:
        store = templates or TemplateStore(table=os.environ["TEMPLATES_TABLE"])
        rows = store.list_for_agent(purpose=event.get("purpose") or None)
    else:
        raise ValueError(
            f"unknown tool {tool!r}; this Lambda serves only {LIST_CONTACTS} and {LIST_TEMPLATES}"
        )
    return {"rows": rows, "count": len(rows)}
