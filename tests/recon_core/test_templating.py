"""Template rendering: declared variables only, and every declared variable supplied."""

import pytest

from backend.recon_core.templating import render_template


def test_renders_declared_variables() -> None:
    out = render_template(
        template="Hi {{name}}, the wire for {{amount}} is unmatched.",
        declared=["name", "amount"],
        values={"name": "Ops", "amount": "26,772.73"},
    )
    assert out == "Hi Ops, the wire for 26,772.73 is unmatched."


def test_renders_the_same_placeholder_twice() -> None:
    out = render_template(
        template="{{name}}, this is for {{name}}.",
        declared=["name"],
        values={"name": "Ops"},
    )
    assert out == "Ops, this is for Ops."


def test_tolerates_whitespace_inside_the_braces() -> None:
    out = render_template(template="Hi {{ name }}", declared=["name"], values={"name": "Ops"})
    assert out == "Hi Ops"


def test_an_undeclared_placeholder_raises() -> None:
    # A placeholder nobody declared cannot be reviewed by the operator who wrote the template, so
    # it would render as literal braces in mail a counterparty reads.
    with pytest.raises(ValueError, match="undeclared"):
        render_template(template="Hi {{nickname}}", declared=["name"], values={"name": "Ops"})


def test_a_missing_value_raises() -> None:
    with pytest.raises(ValueError, match="missing"):
        render_template(template="Hi {{name}}", declared=["name"], values={})


def test_an_extra_value_raises() -> None:
    with pytest.raises(ValueError, match="not declared"):
        render_template(template="Hi {{name}}", declared=["name"], values={"name": "a", "x": "b"})


def test_a_declared_variable_the_template_never_uses_is_fine() -> None:
    # Declaring more than one template body uses is normal: the same variable list feeds both the
    # subject and the body, and the subject rarely uses all of them.
    out = render_template(
        template="Hi {{name}}",
        declared=["name", "amount"],
        values={"name": "Ops", "amount": "1.00"},
    )
    assert out == "Hi Ops"


def test_a_value_is_substituted_literally_not_re_rendered() -> None:
    # A value that itself looks like a placeholder must survive as text. Re-rendering the output
    # would let a value name a variable and read another one's contents.
    out = render_template(template="Hi {{name}}", declared=["name"], values={"name": "{{amount}}"})
    assert out == "Hi {{amount}}"
