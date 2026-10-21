#!/usr/bin/env python3
"""Create the five demonstration operators in a deployment's Cognito user pool, and put them in the
console groups, so a fresh apply is signable-in and the access model is visible in a browser.

WHY THIS EXISTS. `auth_provider = "cognito"` (the default) creates the pool, its hosted UI and the
five console groups -- and NO users. Self sign-up is disabled on purpose (`admin_create_user_only`),
so a first apply ends with a console nobody can open and a hosted UI that will not let anyone make
themselves an account. The recon root's `cognito_first_user_commands` output prints the two CLI calls
that fix that for ONE real operator. This script is the other half: five accounts that between them
demonstrate every state the console can put a viewer in, so "does per-app authorization work" is a
browser question rather than a reading-the-code question.

WHAT IT CREATES. Five accounts, fixed, all at `example.com`:

    recon-analyst@example.com     recon access only        -> Trade Reconciliation alone
    deal-desk-user@example.com    pipeline access only     -> Deal Pipeline alone
    both-apps-admin@example.com   both ADMIN groups        -> both apps, every admin control
    console-admin@example.com     console admin only       -> the Settings screen, NEITHER app
    no-access@example.com         no groups at all         -> the no-access state

The fourth and fifth are the two the others cannot show you. A console admin with no app access is
the state that proves the console-wide layer is separate from app access; a user in no group is the
only way to see what an authenticated stranger gets, and under Cognito that is the DEFAULT state of
every account, because the pool creates its groups empty.

⚠️ THE ADDRESSES ARE NOT CONFIGURABLE, AND THAT IS THE POINT. `example.com` is reserved by RFC 2606
and can receive no mail, so this script cannot email a real person and `--delete` cannot remove a
real operator's account -- the only usernames it will ever touch are the five above. An operator who
wants an account on a mailbox that exists should use `cognito_first_user_commands` from the root's
Terraform output instead; it takes an address as an argument precisely because that one is meant to be
real.

NO EMAIL IS SENT (`MessageAction="SUPPRESS"`). The invite mail would carry the temporary password to
five undeliverable addresses, and Cognito's own sender is capped at 50 messages a day per account, so
a suppressed invite is both the only thing that can work and the only thing that does not spend the
quota. The operator supplies the temporary password instead, and so already has it.

THE TEMPORARY PASSWORD is prompted for, twice, without echo -- so it stays out of shell history --
and this script never prints it, writes it to a file, defaults it, or embeds it in this repo. There is
deliberately no flag that generates one: a generated password would have to be echoed back to be
usable at all, and a secret on stdout is a secret in terminal scrollback, in a `tee`, and in a CI log.
One password serves every account a run creates: all five belong to the same operator demonstrating
one deployment, every one of them lands in `FORCE_CHANGE_PASSWORD` and gets its own password at first
sign-in, and the alternative -- five passwords to keep track of -- is the shape that gets pasted into
a scratch file.

IDEMPOTENT. A second run reports every account as present and adds nothing; `plan_user` is what
decides that, and it decides it from the pool's own answer rather than from a marker this script
wrote. Group membership that this script did not create is LEFT ALONE unless `--prune-groups` is
given: the script's job is to make the demo work, not to own who is in the pool.

    # See what it would do, resolving the pool and the group names from Terraform's state.
    python3 scripts/create_dev_users.py --dry-run --profile <profile>

    # Create them, prompting (twice, without echo) for the temporary password.
    python3 scripts/create_dev_users.py --profile <profile>

    # Against a pool named explicitly, with one group renamed.
    python3 scripts/create_dev_users.py --user-pool-id us-east-1_EXAMPLE \\
        --region us-east-1 --group recon-access=recon-readers

    # Clean up. Removes the five accounts and NO group, because Terraform owns the groups.
    python3 scripts/create_dev_users.py --delete --dry-run
    python3 scripts/create_dev_users.py --delete
"""

from __future__ import annotations

import argparse
import getpass
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import boto3

# The Terraform root that owns the pool. Relative to the repo root, which is this file's parent's
# parent -- so the script works from any working directory, like every other script in here.
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TERRAFORM_DIR = REPO_ROOT / "infra" / "environments" / "recon"

# The two outputs this script reads. `cognito_group_names` is a map keyed by the ROLE the console
# reads each group for, which is why the role keys below are the same strings.
POOL_ID_OUTPUT = "cognito_user_pool_id"
GROUP_NAMES_OUTPUT = "cognito_group_names"

# The five roles, in the order they are reported. Identical to the keys of
# `module.console_auth.group_names` (infra/modules/console-auth/main.tf, local.groups).
ROLES = ("recon-access", "recon-admin", "pipeline-access", "pipeline-admin", "console-admin")

# The group names the pool creates when a deployment renames none of them. A FOURTH copy of these five
# strings (the module's variable defaults, the root's local.cognito_console_groups and the console's
# own environment are the other three), which is only safe because
# tests/scripts/test_create_dev_users.py asserts this dict equals the module's declared defaults. A
# drifted copy would put users in groups that do not exist -- and Cognito answers that with
# ResourceNotFoundException naming a group, not naming this file.
DEFAULT_GROUP_NAMES = {
    "recon-access": "recon-users",
    "recon-admin": "recon-admins",
    "pipeline-access": "deal-desk",
    "pipeline-admin": "deal-desk-admins",
    "console-admin": "console-admins",
}

# The pool's password policy (infra/modules/console-auth/main.tf): 12 characters and all four
# character classes. Checked here so a weak password is refused before five API calls are made, and
# so the refusal names the rule rather than arriving as InvalidPasswordException.
MIN_PASSWORD_LENGTH = 12
# The symbol class Cognito accepts, as its own alphabet. NOT named *_PASSWORD_*: it is a character
# set, and a high-entropy literal beside that word is exactly what a secret scanner reports.
SYMBOL_ALPHABET = "^$*.[]{}()?-\"!@#%&/\\,><':;|_~`+="


@dataclass(frozen=True)
class DevUser:
    """One demonstration account: an address, the console roles it holds, and what it shows."""

    email: str
    roles: tuple[str, ...]
    demonstrates: str


# Ordered from least to most privileged, then the two nobody thinks to create.
DEV_USERS: tuple[DevUser, ...] = (
    DevUser(
        email="recon-analyst@example.com",
        roles=("recon-access",),
        demonstrates="Trade Reconciliation only: the rail shows one app, /api/pipeline/* answers 403",
    ),
    DevUser(
        email="deal-desk-user@example.com",
        roles=("pipeline-access",),
        demonstrates="Deal Pipeline only: may read, chat and simulate, but approves nothing",
    ),
    DevUser(
        email="both-apps-admin@example.com",
        roles=("recon-admin", "pipeline-admin"),
        demonstrates="both apps with every admin control (an admin group implies access)",
    ),
    DevUser(
        email="console-admin@example.com",
        roles=("console-admin",),
        demonstrates="the Settings screen and NEITHER app: console-wide rights are not app access",
    ),
    DevUser(
        email="no-access@example.com",
        roles=(),
        demonstrates="the no-access state every account starts in, since the pool's groups are empty",
    ),
)


@dataclass
class UserPlan:
    """What one account still needs. Empty means a re-run has nothing to do for it."""

    email: str
    create: bool
    add_groups: list[str] = field(default_factory=list)
    remove_groups: list[str] = field(default_factory=list)

    @property
    def is_noop(self) -> bool:
        """Whether this account is already exactly as the script wants it.

        :returns: True when nothing would be created, added or removed.
        """
        return not self.create and not self.add_groups and not self.remove_groups


# --- resolving the deployment ------------------------------------------------------------------


def terraform_outputs(*, directory: Path) -> dict[str, Any]:
    """Read `terraform output -json` from a Terraform root.

    Read-only: `output` renders the state that is already there and refreshes nothing. It still needs
    the root to have been initialised with its backend, which is why the failure is reported with the
    command's own stderr rather than as "could not find the pool" -- an uninitialised directory and an
    Okta deployment are different problems with the same symptom otherwise.

    :param directory: the Terraform root to read (``infra/environments/recon`` by default).
    :returns: the parsed output map, ``{name: {"value": ..., "sensitive": ...}}``.
    :raises RuntimeError: if terraform is absent, the directory is not a usable root, or the output
        is not JSON.
    """
    try:
        completed = subprocess.run(
            ["terraform", "output", "-json"],
            cwd=directory,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:  # terraform not on PATH
        raise RuntimeError(
            f"terraform is not on PATH, so {directory} cannot be read. Pass --user-pool-id "
            "(and --group NAME=VALUE for any renamed group) instead."
        ) from exc

    if completed.returncode != 0:
        raise RuntimeError(
            f"`terraform output -json` failed in {directory} (exit {completed.returncode}). Run "
            f"`terraform init -backend-config=backend.hcl` there first, or pass --user-pool-id "
            f"instead.\n{completed.stderr.strip()}"
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"`terraform output -json` in {directory} did not return JSON") from exc


def resolve_deployment(
    *,
    outputs: dict[str, Any] | None,
    user_pool_id: str | None,
    group_overrides: dict[str, str],
) -> tuple[str, dict[str, str]]:
    """Decide which pool to write to and what the five groups are called.

    Precedence, most explicit first: a `--group` override, then Terraform's output, then
    :data:`DEFAULT_GROUP_NAMES`. `--user-pool-id` likewise wins over the output.

    An output map whose ``cognito_user_pool_id`` is EMPTY is not a missing value, it is a deployment
    that signs in through Okta or Entra -- there is no pool to create users in and no group this
    script could add anyone to. Reported as that, by name, rather than as an absent output: the
    difference decides whether the operator changes a variable or changes directory.

    :param outputs: parsed `terraform output -json`, or None when it was not consulted.
    :param user_pool_id: the pool id from the command line, if given.
    :param group_overrides: role -> group name pairs from ``--group``.
    :returns: (pool id, role -> group name for all five roles).
    :raises ValueError: when no pool can be identified, or an override names an unknown role.
    """
    unknown = sorted(set(group_overrides) - set(ROLES))
    if unknown:
        raise ValueError(
            f"--group named unknown role(s) {', '.join(unknown)}; expected one of {', '.join(ROLES)}"
        )

    outputs = outputs or {}
    from_output = str(outputs.get(POOL_ID_OUTPUT, {}).get("value") or "").strip()
    resolved_pool = (user_pool_id or "").strip() or from_output
    if not resolved_pool:
        if POOL_ID_OUTPUT in outputs:
            raise ValueError(
                f"the deployment's {POOL_ID_OUTPUT} output is empty, which means auth_provider is "
                "'okta' or 'entra': that deployment has no user pool of its own, so there is no "
                'account for this script to create. Set auth_provider = "cognito" and re-apply, or '
                "point --user-pool-id at a pool you do own."
            )
        raise ValueError(
            f"no user pool: {POOL_ID_OUTPUT} is not among the Terraform outputs and --user-pool-id "
            "was not given."
        )

    named = outputs.get(GROUP_NAMES_OUTPUT, {}).get("value") or {}
    groups = {
        role: str(group_overrides.get(role) or named.get(role) or DEFAULT_GROUP_NAMES[role]).strip()
        for role in ROLES
    }
    blank = sorted(role for role, name in groups.items() if not name)
    if blank:
        raise ValueError(
            f"group name(s) for {', '.join(blank)} resolved to blank; pass --group <role>=<name>"
        )
    return resolved_pool, groups


# --- the temporary password --------------------------------------------------------------------


def password_complaint(password: str) -> str | None:
    """Check a password against the pool's policy, locally.

    The pool requires 12 characters and all four character classes. Refusing here rather than at the
    API means the operator is told the rule once, before any account exists -- an
    InvalidPasswordException on the third of five users leaves a half-created set behind.

    :param password: the candidate temporary password.
    :returns: a human-readable complaint, or None when the password satisfies the policy.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"must be at least {MIN_PASSWORD_LENGTH} characters (the pool's password_policy)"
    missing = [
        name
        for name, present in (
            ("a lowercase letter", any(c.islower() for c in password)),
            ("an uppercase letter", any(c.isupper() for c in password)),
            ("a digit", any(c.isdigit() for c in password)),
            ("a symbol", any(c in SYMBOL_ALPHABET for c in password)),
        )
        if not present
    ]
    if missing:
        return "must contain " + ", ".join(missing) + " (the pool requires all four classes)"
    return None


def prompt_password(*, prompt: Any = getpass.getpass) -> str:
    """Ask for the temporary password twice, without echo, and validate it.

    The only way this script obtains a password. There is deliberately no generator beside it: the
    operator has to end up knowing the password, so a generated one would have to be written to
    stdout, and that is a cleartext secret in scrollback, in a redirect, and in a CI log.

    :param prompt: the no-echo prompt to call (injected in tests).
    :returns: the confirmed password.
    :raises ValueError: when the two entries differ or the password fails the pool's policy.
    """
    first = prompt("Temporary password for the demonstration accounts (not echoed): ")
    complaint = password_complaint(first)
    if complaint:
        raise ValueError(f"temporary password {complaint}")
    if prompt("Repeat it: ") != first:
        raise ValueError("the two entries did not match")
    return first


# --- reading and changing the pool -------------------------------------------------------------


def _error_code(exc: Exception) -> str:
    """The AWS error code on a botocore ClientError, or "" for anything else.

    Read off ``response`` rather than by catching a client-specific exception class, because those are
    generated per client and a fake would have to reproduce the factory to be caught.

    :param exc: the exception raised by a boto3 call.
    :returns: the error code, or "" when the exception carries none.
    """
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return ""
    return str(response.get("Error", {}).get("Code", ""))


def current_state(*, client: Any, user_pool_id: str, email: str) -> tuple[bool, list[str]]:
    """Read whether an account exists and which groups it is in.

    :param client: a boto3 ``cognito-idp`` client.
    :param user_pool_id: the pool to read.
    :param email: the account's username, which is its email address (the pool signs in by email).
    :returns: (exists, the group names it currently holds; empty when it does not exist).
    """
    try:
        client.admin_get_user(UserPoolId=user_pool_id, Username=email)
    except Exception as exc:  # noqa: BLE001 - narrowed on the AWS error code immediately below
        if _error_code(exc) == "UserNotFoundException":
            return False, []
        raise

    paginated: list[str] = []
    token: str | None = None
    while True:
        kwargs = {"UserPoolId": user_pool_id, "Username": email}
        if token:
            kwargs["NextToken"] = token
        page = client.admin_list_groups_for_user(**kwargs)
        paginated += [str(group["GroupName"]) for group in page.get("Groups", [])]
        token = page.get("NextToken")
        if not token:
            return True, paginated


def plan_user(
    *,
    user: DevUser,
    groups: dict[str, str],
    exists: bool,
    current_groups: list[str],
    prune: bool,
) -> UserPlan:
    """Decide what one account still needs, from the pool's own answer.

    This is the whole of the idempotency: a second run sees the account and its memberships and
    produces an empty plan, rather than repeating calls that happen to be harmless. `add_groups` is
    ordered by :data:`ROLES` so a report reads the same way twice.

    A group the account holds that this script did not ask for is reported for removal ONLY under
    `prune`. Membership added by hand -- the operator's own group, a federated provider's mapped
    group -- is not this script's to revoke by default.

    :param user: the demonstration account.
    :param groups: role -> group name, as resolved for this deployment.
    :param exists: whether the account is already in the pool.
    :param current_groups: the group names it currently holds.
    :param prune: when true, plan removal of every membership outside the account's roles.
    :returns: the plan; :attr:`UserPlan.is_noop` when there is nothing to do.
    """
    wanted = [groups[role] for role in ROLES if role in user.roles]
    held = set(current_groups)
    return UserPlan(
        email=user.email,
        create=not exists,
        add_groups=[name for name in wanted if name not in held],
        remove_groups=(
            sorted(name for name in held if name not in wanted) if prune and exists else []
        ),
    )


def apply_plan(*, client: Any, user_pool_id: str, plan: UserPlan, temporary_password: str) -> None:
    """Create the account if it is missing and reconcile its group membership.

    `MessageAction="SUPPRESS"` because the address cannot receive mail (see the module docstring);
    `email_verified` is set so the account is usable and the forgot-password flow is reachable
    without a delivery nobody can complete.

    A `UsernameExistsException` is swallowed and the group reconciliation still runs: the existence
    check and this call are two round trips, and a concurrent run (or an account created by hand
    between them) must not abort a script whose entire contract is that re-running is safe.

    :param client: a boto3 ``cognito-idp`` client.
    :param user_pool_id: the pool to write to.
    :param plan: the plan from :func:`plan_user`.
    :param temporary_password: the FORCE_CHANGE_PASSWORD credential for a newly created account.
    :returns: None.
    """
    if plan.create:
        try:
            client.admin_create_user(
                UserPoolId=user_pool_id,
                Username=plan.email,
                UserAttributes=[
                    {"Name": "email", "Value": plan.email},
                    {"Name": "email_verified", "Value": "true"},
                ],
                TemporaryPassword=temporary_password,
                MessageAction="SUPPRESS",
            )
        except Exception as exc:  # noqa: BLE001 - narrowed on the AWS error code
            if _error_code(exc) != "UsernameExistsException":
                raise

    for group in plan.add_groups:
        client.admin_add_user_to_group(
            UserPoolId=user_pool_id, Username=plan.email, GroupName=group
        )
    for group in plan.remove_groups:
        client.admin_remove_user_from_group(
            UserPoolId=user_pool_id, Username=plan.email, GroupName=group
        )


def delete_user(*, client: Any, user_pool_id: str, email: str) -> bool:
    """Remove one demonstration account, tolerating its absence.

    Only the account. NEVER the group: the five groups are Terraform's
    (`infra/modules/console-auth`), and deleting one here would leave the next plan proposing to
    recreate a group whose membership had been silently emptied.

    :param client: a boto3 ``cognito-idp`` client.
    :param user_pool_id: the pool to write to.
    :param email: the account's username.
    :returns: True when an account was deleted, False when there was none.
    """
    try:
        client.admin_delete_user(UserPoolId=user_pool_id, Username=email)
    except Exception as exc:  # noqa: BLE001 - narrowed on the AWS error code
        if _error_code(exc) == "UserNotFoundException":
            return False
        raise
    return True


# --- the two runs ------------------------------------------------------------------------------


def run_create(
    *,
    client: Any,
    user_pool_id: str,
    groups: dict[str, str],
    temporary_password: str,
    dry_run: bool,
    prune: bool,
) -> dict[str, int]:
    """Create or reconcile all five accounts, printing one line each.

    :param client: a boto3 ``cognito-idp`` client.
    :param user_pool_id: the pool to write to.
    :param groups: role -> group name for this deployment.
    :param temporary_password: the credential newly created accounts are given.
    :param dry_run: report what would happen and change nothing.
    :param prune: revoke memberships outside each account's roles.
    :returns: counts keyed ``created``, ``updated``, ``unchanged``.
    """
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    for user in DEV_USERS:
        exists, held = current_state(client=client, user_pool_id=user_pool_id, email=user.email)
        plan = plan_user(user=user, groups=groups, exists=exists, current_groups=held, prune=prune)

        wanted = [groups[role] for role in ROLES if role in user.roles]
        membership = ", ".join(wanted) if wanted else "no groups"
        if plan.is_noop:
            counts["unchanged"] += 1
            print(f"  UNCHANGED  {user.email:<28} {membership}")
            continue

        counts["created" if plan.create else "updated"] += 1
        verb = "WOULD SET " if dry_run else ("CREATE   " if plan.create else "UPDATE   ")
        detail = []
        if plan.create:
            detail.append("new account")
        if plan.add_groups:
            detail.append("+ " + ", ".join(plan.add_groups))
        if plan.remove_groups:
            detail.append("- " + ", ".join(plan.remove_groups))
        print(f"  {verb:<10} {user.email:<28} {'; '.join(detail)}")
        if not dry_run:
            apply_plan(
                client=client,
                user_pool_id=user_pool_id,
                plan=plan,
                temporary_password=temporary_password,
            )
    return counts


def run_delete(*, client: Any, user_pool_id: str, dry_run: bool) -> dict[str, int]:
    """Remove all five accounts, printing one line each.

    :param client: a boto3 ``cognito-idp`` client.
    :param user_pool_id: the pool to write to.
    :param dry_run: report what would happen and change nothing.
    :returns: counts keyed ``deleted``, ``absent``.
    """
    counts = {"deleted": 0, "absent": 0}
    for user in DEV_USERS:
        if dry_run:
            exists, _ = current_state(client=client, user_pool_id=user_pool_id, email=user.email)
            counts["deleted" if exists else "absent"] += 1
            print(f"  {'WOULD DELETE' if exists else 'ABSENT      '} {user.email}")
            continue
        if delete_user(client=client, user_pool_id=user_pool_id, email=user.email):
            counts["deleted"] += 1
            print(f"  DELETED      {user.email}")
        else:
            counts["absent"] += 1
            print(f"  ABSENT       {user.email}")
    return counts


def print_access_model(*, groups: dict[str, str]) -> None:
    """Print what each account is for, resolved against this deployment's group names.

    The report an operator actually acts on: five addresses is not useful without knowing which one to
    sign in as to see which behaviour.

    :param groups: role -> group name for this deployment.
    :returns: None.
    """
    print("\nWhat to sign in as:")
    for user in DEV_USERS:
        held = ", ".join(groups[role] for role in ROLES if role in user.roles) or "(none)"
        print(f"  {user.email:<28} {held:<34} {user.demonstrates}")


def parse_group_override(raw: str) -> tuple[str, str]:
    """Parse one ``--group role=name`` argument.

    :param raw: the argument value.
    :returns: (role, group name).
    :raises argparse.ArgumentTypeError: when it is not ``role=name`` with both halves present.
    """
    role, _, name = raw.partition("=")
    if not role.strip() or not name.strip():
        raise argparse.ArgumentTypeError(
            f"--group expects <role>=<group-name>, got {raw!r}; roles are {', '.join(ROLES)}"
        )
    return role.strip(), name.strip()


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, resolve the deployment, and create or delete the accounts.

    :param argv: argument vector, defaulting to ``sys.argv[1:]``.
    :returns: process exit status; 0 on success, 2 on a resolution or password failure.
    """
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--user-pool-id",
        default=None,
        help="the Cognito user pool to write to; default: the cognito_user_pool_id output of the "
        "Terraform root below",
    )
    parser.add_argument(
        "--terraform-dir",
        type=Path,
        default=DEFAULT_TERRAFORM_DIR,
        help=f"Terraform root to read the pool id and group names from (default: "
        f"{DEFAULT_TERRAFORM_DIR.relative_to(REPO_ROOT)}). Not consulted when --user-pool-id is "
        f"given together with every renamed --group",
    )
    parser.add_argument(
        "--group",
        action="append",
        type=parse_group_override,
        default=[],
        metavar="ROLE=NAME",
        help=f"override one group name; ROLE is one of {', '.join(ROLES)}. Repeatable. Wins over the "
        f"Terraform output",
    )
    parser.add_argument("--profile", default=None, help="AWS profile to use")
    parser.add_argument("--region", default=None, help="AWS region the pool is in")
    parser.add_argument(
        "--prune-groups",
        action="store_true",
        help="also revoke memberships outside each account's roles; by default a group added outside "
        "this script is left alone",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="remove the five accounts instead of creating them. Deletes no group: Terraform owns "
        "those",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="report what would change and change nothing"
    )
    args = parser.parse_args(argv)

    group_overrides = dict(args.group)
    # Terraform is skipped only when the command line already answers everything, so the common case
    # (`--dry-run` with no arguments at all) still reads the real deployment.
    need_terraform = not args.user_pool_id or set(group_overrides) != set(ROLES)
    outputs: dict[str, Any] | None = None
    if need_terraform:
        try:
            outputs = terraform_outputs(directory=args.terraform_dir)
        except RuntimeError as exc:
            if not args.user_pool_id:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            # A pool WAS named, so the outputs were only wanted for the group names; the documented
            # defaults cover that and the run continues with them.
            print(f"note: {exc}\nnote: falling back to the default group names.", file=sys.stderr)

    try:
        user_pool_id, groups = resolve_deployment(
            outputs=outputs, user_pool_id=args.user_pool_id, group_overrides=group_overrides
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    client = session.client("cognito-idp")

    if args.delete:
        mode = "dry run (nothing will be deleted)" if args.dry_run else "DELETING"
        print(f"[dev-users] {mode} the 5 demonstration accounts in {user_pool_id}")
        counts = run_delete(client=client, user_pool_id=user_pool_id, dry_run=args.dry_run)
        print(f"[dev-users] deleted={counts['deleted']} absent={counts['absent']}")
        print("[dev-users] no group was touched — the five console groups are Terraform's.")
        return 0

    temporary_password = ""
    if not args.dry_run:
        try:
            temporary_password = prompt_password()
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    mode = "dry run (nothing will be created)" if args.dry_run else "CREATING"
    print(f"[dev-users] {mode} the 5 demonstration accounts in {user_pool_id}")
    counts = run_create(
        client=client,
        user_pool_id=user_pool_id,
        groups=groups,
        temporary_password=temporary_password,
        dry_run=args.dry_run,
        prune=args.prune_groups,
    )
    print(
        f"[dev-users] created={counts['created']} updated={counts['updated']} "
        f"unchanged={counts['unchanged']}"
    )
    print_access_model(groups=groups)

    if args.dry_run:
        print("\n[dev-users] nothing was created. Re-run without --dry-run.")
        return 0

    # The password is never echoed back -- the operator typed it, so the only copy is the one they
    # already have, and nothing sensitive reaches stdout, a log, a file, or the environment.
    print(
        "\n[dev-users] every new account holds the temporary password you typed, and must "
        "change it at first sign-in."
    )
    print(
        "[dev-users] sign in at the hosted UI (`terraform output -raw cognito_hosted_ui_url`), or "
        "open the console and let it redirect you."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
