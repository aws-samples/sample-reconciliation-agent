"""Rendering for operator-authored email templates.

Deliberately not Jinja. A template here is operator input that ends up in mail a counterparty reads,
and Jinja's expression language would make an injected template a code-execution surface. The whole
grammar is ``{{name}}`` substitution, and anything outside it is an error rather than a passthrough.

Substitution is single-pass: a value that itself contains ``{{other}}`` is emitted as literal text.
Re-rendering the output would let one variable's value name another variable and read its contents.
"""

import re

# The whole template grammar. Optional inner whitespace is tolerated because operators type it, but
# the name itself is restricted so a placeholder can never carry an expression.
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


def placeholders_in(*, template: str) -> set[str]:
    """The variable names a template refers to.

    Shared with the store's save-time validation so there is exactly one definition of what counts
    as a placeholder. A second copy of the regex would let a template pass validation and then fail
    to render, or vice versa.

    :param template: the raw subject or body template.
    :returns: the distinct placeholder names used, in no particular order.
    """
    return set(_PLACEHOLDER.findall(template))


def render_template(*, template: str, declared: list[str], values: dict[str, str]) -> str:
    """Substitute ``{{name}}`` placeholders, raising on any mismatch between the three inputs.

    :param template: the raw subject or body template.
    :param declared: the variable names the template's author declared in ``variables``.
    :param values: the values supplied for this render.
    :returns: the rendered text.
    :raises ValueError: if the template uses a placeholder that is not declared, if a declared
        placeholder has no value, or if a value was supplied for a name nobody declared. All three
        are the same class of bug — the operator's declaration and the caller's payload disagree —
        and none of them may render as literal braces in outgoing mail.
    """
    declared_set = set(declared)
    used = placeholders_in(template=template)
    undeclared = sorted(used - declared_set)
    if undeclared:
        raise ValueError(f"template uses undeclared variables: {', '.join(undeclared)}")
    extra = sorted(set(values) - declared_set)
    if extra:
        raise ValueError(
            f"values supplied for names not declared on this template: {', '.join(extra)}"
        )
    missing = sorted(used - set(values))
    if missing:
        raise ValueError(f"missing values for declared variables: {', '.join(missing)}")
    # re.sub with a function, not str.replace in a loop: the replacement text is never re-scanned,
    # so a value containing braces stays literal.
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], template)
