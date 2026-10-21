"""The frontend image's build arguments, pinned against the buildspec that passes them.

⚠️ WHY THIS TEST EXISTS AND WHY IT IS NOT PARANOIA

`docker build --build-arg FOO=bar` against a Dockerfile that declares no `ARG FOO` does NOT fail. It
prints `[Warning] One or more build-args were not consumed` into a CodeBuild log nobody reads and
carries on, so the image builds green with the value missing. For a `NEXT_PUBLIC_*` argument that is
the worst possible failure shape, because Next.js inlines those into the BROWSER bundle at build time:
the value becomes `undefined` in the shipped JavaScript, and nothing at runtime can recover it.

That happened. The four `NEXT_PUBLIC_COGNITO_*` arguments were added to
`infra/modules/frontend-ecs`'s buildspec without the matching `ARG` lines, so every image built with
the default (Cognito) provider had `HAS_COGNITO_CONFIG === false` — which makes
`CognitoAuthWrapper` take its unauthenticated pass-through and render the whole console to an
anonymous visitor while every `/api/*` call 401s, with a green apply and nothing in the browser
pointing at the cause.

The two lists therefore have to be checked against each other by something, and this is it. The check
is on the NAMES only: whether a value is correct is the Terraform variables' business, and the
task-environment half is covered by modules/frontend-ecs's own Terraform tests.
"""

import pathlib
import re

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_DOCKERFILE = _ROOT / "chatbot-app" / "frontend" / "Dockerfile"
_FRONTEND_ECS = _ROOT / "infra" / "modules" / "frontend-ecs" / "main.tf"


def _buildspec_public_args() -> set[str]:
    """Names of the ``NEXT_PUBLIC_*`` build arguments the CodeBuild buildspec passes.

    :returns: the argument names, e.g. {"NEXT_PUBLIC_AWS_REGION", ...}.
    """
    text = _FRONTEND_ECS.read_text(encoding="utf-8")
    return set(re.findall(r"--build-arg\s+(NEXT_PUBLIC_[A-Z0-9_]+)=", text))


def _dockerfile_args() -> set[str]:
    """Names declared with ``ARG`` in the Dockerfile (the builder stage declares them all).

    :returns: the declared argument names.
    """
    text = _DOCKERFILE.read_text(encoding="utf-8")
    return set(re.findall(r"^ARG\s+([A-Za-z0-9_]+)", text, flags=re.MULTILINE))


def _dockerfile_envs() -> set[str]:
    """Names re-exported as ``ENV NAME=$NAME`` in the Dockerfile.

    :returns: the exported names whose value is the same-named build argument.
    """
    text = _DOCKERFILE.read_text(encoding="utf-8")
    return {
        name
        for name, value in re.findall(
            r"^ENV\s+([A-Za-z0-9_]+)=\$\{?([A-Za-z0-9_]+)\}?", text, flags=re.MULTILINE
        )
        if name == value
    }


def test_every_buildspec_build_arg_is_declared_in_the_dockerfile():
    """An undeclared --build-arg is silently dropped, so the pair must not drift."""
    passed = _buildspec_public_args()
    # Guard the guard: a refactor that renamed the buildspec (or moved the docker build out of this
    # file) would otherwise make this test vacuously pass with an empty set.
    assert len(passed) >= 8, f"found only {sorted(passed)} in {_FRONTEND_ECS}"
    missing = passed - _dockerfile_args()
    assert not missing, (
        f"{_DOCKERFILE} declares no ARG for {sorted(missing)}, which docker build DROPS with only a "
        "warning — the browser bundle would ship them as undefined"
    )


def test_declared_public_args_are_exported_as_env_for_the_next_build():
    """`ARG` alone is invisible to `npm run build`; only `ENV NAME=$NAME` reaches Next.js."""
    declared_public = {name for name in _dockerfile_args() if name.startswith("NEXT_PUBLIC_")}
    assert declared_public, f"no NEXT_PUBLIC_* ARG found in {_DOCKERFILE}"
    missing = declared_public - _dockerfile_envs()
    assert not missing, (
        f"{sorted(missing)} are declared as ARG but never exported as ENV, so `npm run build` cannot "
        "see them and Next.js inlines them as undefined"
    )


def test_the_cognito_build_args_the_pkce_flow_reads_are_present():
    """Named explicitly, because these four are what the DEFAULT provider signs in with.

    `src/lib/auth/cognito-pkce.ts` reads NEXT_PUBLIC_COGNITO_HOSTED_UI and _CLIENT_ID to decide
    HAS_COGNITO_CONFIG; _REDIRECT_URI pins the callback URL and _USER_POOL_ID is what the browser
    reports about which pool it is talking to. The generic tests above compare two lists, so they
    would both pass if the buildspec ALSO lost these lines.
    """
    expected = {
        "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
        "NEXT_PUBLIC_COGNITO_CLIENT_ID",
        "NEXT_PUBLIC_COGNITO_HOSTED_UI",
        "NEXT_PUBLIC_COGNITO_REDIRECT_URI",
    }
    assert expected <= _buildspec_public_args()
    assert expected <= _dockerfile_args()
    assert expected <= _dockerfile_envs()
