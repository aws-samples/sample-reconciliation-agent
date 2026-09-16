# Run from this module's directory: `terraform init && terraform test`.
#
# PLAN-ONLY, and that is load-bearing: the module drives two local-exec provisioners (the frontend
# source upload and the CodeBuild trigger) that Terraform core -- not the mocked provider -- would run
# on apply, zipping a directory and calling the AWS CLI. A plan never runs a provisioner.
#
# private_vpc = true so the two data sources (default internet gateway, CloudFront prefix list) and
# the CloudFront/WAF resources are skipped; none of them bears on what is under test, which is the
# per-app WIRING (var.app_wiring): a recon-only console renders the environment and policy it always
# has, byte for byte (pinned by hash below); an enabled app's variables and grants are appended after
# every recon variable and statement, in app order and then EXACTLY as the app exported them, never
# re-sorted (the order is part of the task definition, so re-ordering would roll every console with
# an app enabled); a disabled app contributes nothing; and a duplicated variable name fails at plan. The apps here are SYNTHETIC. What the
# deal-pipeline app exports is that module's contract, tested in
# modules/deal-pipeline/tests/console_wiring.tftest.hcl; this module knows apps only in the abstract.
#
# override_during = plan makes the overridden computed values known at plan time. Without it the
# ECR repository URL is unknown until apply, and because the container image is `<url>:<hash>` the
# whole container_definitions string -- the environment included -- is unknown and unassertable.

mock_provider "aws" {
  override_during = plan

  override_resource {
    target = aws_ecr_repository.frontend
    values = {
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/frontend-test"
    }
  }

  # The public host in private_vpc mode, so the two Cognito URL outputs are known at plan. Nothing in
  # the task policy or the container environment reads the load balancer, so this override does not
  # bear on either golden hash.
  #
  # `arn` has to be given alongside `dns_name`: an override_resource replaces the whole computed set,
  # so leaving it out hands aws_lb_listener.http a generated placeholder that its own ARN validation
  # rejects at plan.
  override_resource {
    target = aws_lb.this
    values = {
      dns_name = "internal-frontend-test-000000.us-east-1.elb.amazonaws.com"
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/frontend-test/0000000000000000"
    }
  }
}

mock_provider "null" {}

variables {
  name_prefix = "frontend-test"
  region      = "us-east-1"
  account_id  = "123456789012"
  # A directory that does not exist: fileset() yields nothing, so the source hash is the build
  # config alone and the run does not hash the real frontend tree.
  frontend_dir = "tests/fixtures/no-such-frontend"
  vpc_id       = "vpc-00000000000000000"

  private_vpc                   = true
  private_subnet_ids            = ["subnet-00000000000000001", "subnet-00000000000000002"]
  vpc_cidr                      = "10.0.0.0/16"
  ecs_private_security_group_id = "sg-00000000000000000"

  recon_api_base = "https://api.example.test"

  # A Cognito deployment's three runtime names, so the golden environment below covers them with real
  # values rather than the empty strings an Okta deployment would render. auth_provider is left at its
  # module default ("entra"), which is what makes the pair below a genuine mixed-provider rendering:
  # every auth name is present, and which ones are populated is a deployment's choice, not a change of
  # shape in the task definition.
  cognito_user_pool_id = "us-east-1_Example1"
  cognito_client_id    = "client"
  cognito_hosted_ui    = "login.example.test"

  cases_table          = "frontend-test-cases"
  cases_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-cases"
  audit_table          = "frontend-test-audit"
  audit_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-audit"
  assets_bucket        = "frontend-test-assets"
  assets_bucket_arn    = "arn:aws:s3:::frontend-test-assets"
  lessons_table        = "frontend-test-lessons"
  lessons_table_arn    = "arn:aws:dynamodb:us-east-1:123456789012:table/frontend-test-lessons"
  tier1_enabled_param  = "/frontend-test/tier1-enabled"
  harness_service_name = "harness_frontend_test.DEFAULT"

  recon_access_group    = "recon-users"
  pipeline_access_group = "deal-desk"
  pipeline_admin_group  = "deal-desk-admins"

  # GOLDEN. sha256 of the task-policy JSON and of the container-environment JSON this module renders
  # for exactly the inputs above with no app enabled. That is the recon-only console's policy and
  # environment: every recon-only run below must hash to them, and so must the recon half of every
  # enabled run, which is what proves `app_wiring` contributes nothing when no app is enabled.
  #
  # A change here is a change to what every deployed recon console runs, so make it on purpose. To
  # regenerate, temporarily replace an assert's `error_message` with the value itself — the container
  # environment carries a sensitive variable, so it needs unwrapping:
  #   nonsensitive(sha256(aws_iam_role_policy.ecs_task.policy))
  #   nonsensitive(sha256(jsonencode(jsondecode(nonsensitive(aws_ecs_task_definition.frontend.container_definitions))[0].environment)))
  #
  # Retaken 2026-09-16 when this branch merged origin/main: upstream removed Cognito, so
  # COGNITO_HOSTED_UI and COGNITO_CLIENT_ID left the container environment and the OIDC issuer and
  # audience the intake API shares with the BFF took their place. The previous pair
  # (df19d661…/0c35474a…) belongs to the pre-merge rendering and would fail against any tree that
  # has upstream's auth wiring.
  #
  # The ENVIRONMENT hash was retaken again on 2026-09-16, in the change that made Cognito the console's
  # DEFAULT identity provider: COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and COGNITO_HOSTED_UI joined the
  # task environment after OKTA_CLIENT_ID, in that order, always present and empty for an Okta or Entra
  # deployment (the same way OKTA_ISSUER is empty for an Entra one). Three added names and three added
  # values move the hash; nothing that was already there moved. The previous environment value
  # (b5d8270d…) belongs to the tree with no Cognito wiring at all.
  #
  # The POLICY hash is deliberately UNCHANGED across that same change, and that is worth stating: the
  # console verifies pool tokens by fetching a public JWKS document over HTTPS, so the ECS task role
  # gained no cognito-idp grant of any kind. The only IAM that moved is the deploy-actions actor's, in
  # its own module and its own test.
  golden_recon_policy_sha256      = "0aedcb7452916db802218a08411a258b17dd939e8802ad690aca3f690ed6ae2e"
  golden_recon_environment_sha256 = "a97992fc56c22a43fae2b62afef91a5d887615d22d608e9d2321dfb0ed009ac6"

  # Synthetic apps. alpha and beta are enabled, gamma is not. The names are chosen so that a sort by
  # name WOULD interleave the two apps (ALPHA_BUCKET, BETA_QUEUE, ZULU_TABLE) and would move alpha's
  # ZULU_TABLE behind its ALPHA_BUCKET: the enabled run below can therefore tell "appended exactly as
  # exported" (ZULU_TABLE, ALPHA_BUCKET, BETA_QUEUE) from any re-ordering. The statements cover both
  # shapes a real one takes: a list Resource, and a string Resource with a Condition. Sid is test-only -- recon's statements carry none, which is how the
  # runs tell the two halves of the policy apart.
  wired_apps = {
    alpha = {
      enabled = true
      environment = [
        { name = "ZULU_TABLE", value = "alpha-zulu" },
        { name = "ALPHA_BUCKET", value = "alpha-assets" },
      ]
      task_statements = [
        jsonencode({ Sid = "AlphaTable", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = ["arn:aws:dynamodb:us-east-1:123456789012:table/alpha-zulu"] }),
        jsonencode({ Sid = "AlphaList", Effect = "Allow", Action = ["s3:ListBucket"], Resource = "arn:aws:s3:::alpha-assets", Condition = { StringLike = { "s3:prefix" = ["skills/*"] } } }),
      ]
    }
    beta = {
      enabled         = true
      environment     = [{ name = "BETA_QUEUE", value = "beta-queue" }]
      task_statements = [jsonencode({ Sid = "BetaQueue", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = "arn:aws:sqs:us-east-1:123456789012:beta-queue" })]
    }
    gamma = {
      enabled         = false
      environment     = [{ name = "GAMMA_TABLE", value = "gamma-table" }]
      task_statements = [jsonencode({ Sid = "GammaTable", Effect = "Allow", Action = ["dynamodb:Scan"], Resource = "arn:aws:dynamodb:us-east-1:123456789012:table/gamma-table" })]
    }
  }
}

# app_wiring at its default: the recon-only console. The three access-control names and the two
# switches are always present -- the proxy resolves every registered app from them whether or not a
# second app is deployed -- and the whole policy and environment are what they were before the rail.
run "recon_only_console_is_unchanged_apart_from_the_group_and_switch_variables" {
  command = plan

  assert {
    condition = alltrue([
      for name in ["RECON_ACCESS_GROUP", "PIPELINE_ACCESS_GROUP", "PIPELINE_ADMIN_GROUP"] :
      contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], name)
    ])
    error_message = "RECON_ACCESS_GROUP, PIPELINE_ACCESS_GROUP and PIPELINE_ADMIN_GROUP must be in the task environment even when no second app is deployed"
  }

  # PIPELINE_ENABLED=false is what makes the shell hide the app and refuse /api/pipeline/*; without it
  # every authenticated user saw a Deal Pipeline entry whose pages failed with a missing-variable 500.
  # REQUIRE_ACCESS_GROUPS=false keeps a blank access group open, which is what this console had before
  # the rail existed.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_ENABLED"] == "false"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["REQUIRE_ACCESS_GROUPS"] == "false"
    )
    error_message = "a recon-only console must render PIPELINE_ENABLED=false and REQUIRE_ACCESS_GROUPS=false"
  }

  # The property that protects recon: the task policy is BYTE-FOR-BYTE the one rendered before this
  # module had an app_wiring input.
  assert {
    condition     = sha256(aws_iam_role_policy.ecs_task.policy) == var.golden_recon_policy_sha256
    error_message = "the recon-only task policy no longer matches the golden rendering; a recon grant changed"
  }

  # ... and so is the container environment, order included (a reorder alone is a new task
  # definition revision and a rolling deployment of the console).
  assert {
    condition     = sha256(jsonencode(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment)) == var.golden_recon_environment_sha256
    error_message = "the recon-only container environment no longer matches the golden rendering; a recon variable, value or position changed"
  }

  # Nothing app-shaped is in the policy: recon's statements carry no Sid.
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : can(s.Sid)])
    error_message = "with app_wiring empty the task policy must carry no app statement"
  }

  # Every auth name the BFF resolves a provider from is present whichever provider is selected, so the
  # task definition's SHAPE does not depend on the choice: src/lib/api-auth.ts reads AUTH_PROVIDER and
  # then that provider's names, answering 503 when they are blank rather than accepting an unverified
  # token. A name that is absent instead of empty is indistinguishable at runtime from one that was
  # never wired, which is exactly the ambiguity this pins.
  assert {
    condition = alltrue([
      for name in ["AUTH_PROVIDER", "OKTA_ISSUER", "OKTA_CLIENT_ID", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_HOSTED_UI", "AUTH_GROUPS_CLAIM"] :
      contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], name)
    ])
    error_message = "the task environment must name every auth variable for every provider -- AUTH_PROVIDER, the Okta pair, the Cognito three and AUTH_GROUPS_CLAIM -- present and empty when the selected provider does not use it"
  }

  # And the Cognito three carry the pool this module was handed, not a derived or reformatted version
  # of it: the BFF composes the issuer from the pool id verbatim, and the hosted-UI host is what the
  # browser is redirected to.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["COGNITO_USER_POOL_ID"] == "us-east-1_Example1"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["COGNITO_CLIENT_ID"] == "client"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["COGNITO_HOSTED_UI"] == "login.example.test"
    )
    error_message = "COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID and COGNITO_HOSTED_UI must reach the task with the module inputs' values, unaltered"
  }

  # The ECS task role gains NOTHING for Cognito, and that is the point: token verification is an HTTPS
  # fetch of a public JWKS document, not an AWS API call. A cognito-idp grant appearing here would mean
  # someone had reached for the control plane where the OIDC metadata endpoint was enough.
  assert {
    condition = !anytrue(flatten([
      for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement :
      [for a in flatten([s.Action]) : startswith(a, "cognito-idp:") || startswith(a, "cognito-identity:")]
    ]))
    error_message = "the console task role must hold no Cognito action: it verifies tokens against a public JWKS URL and never calls the Cognito control plane"
  }
}

# A map full of wiring with nothing enabled renders exactly like the empty map: the same two hashes.
# This is the composed root's shape with enable_deal_pipeline = false (an entry, disabled, its lists
# empty), and also what a root passing a still-populated entry with enabled = false must get.
run "a_disabled_app_contributes_nothing" {
  command = plan

  variables {
    app_wiring = {
      alpha = merge(var.wired_apps.alpha, { enabled = false })
      beta  = merge(var.wired_apps.beta, { enabled = false })
      gamma = var.wired_apps.gamma
    }
  }

  assert {
    condition     = sha256(aws_iam_role_policy.ecs_task.policy) == var.golden_recon_policy_sha256
    error_message = "a disabled app must leave the task policy byte-for-byte the recon-only one"
  }

  assert {
    condition     = sha256(jsonencode(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment)) == var.golden_recon_environment_sha256
    error_message = "a disabled app must leave the container environment byte-for-byte the recon-only one"
  }

  assert {
    condition = length(setintersection(
      toset([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]),
      toset(["ALPHA_BUCKET", "ZULU_TABLE", "BETA_QUEUE", "GAMMA_TABLE"]),
    )) == 0
    error_message = "a disabled app's variables must not reach the task environment"
  }
}

# Two apps behind one OIDC client with a blank access group would admit the whole deal desk to the
# recon app -- and recon has write routes gated by the access check alone. The plan refuses it, on
# the variable the operator flips, naming both groups.
run "pipeline_enabled_with_a_blank_recon_access_group_fails_at_plan" {
  command = plan

  variables {
    pipeline_enabled   = true
    recon_access_group = ""
  }

  expect_failures = [var.pipeline_enabled]
}

# Whitespace is blank too: the console trims the group before comparing, so the validation must not
# let "  " through as a configured group.
run "pipeline_enabled_with_a_whitespace_pipeline_access_group_fails_at_plan" {
  command = plan

  variables {
    pipeline_enabled      = true
    pipeline_access_group = "  "
  }

  expect_failures = [var.pipeline_enabled]
}

run "enabled_apps_append_their_variables_as_exported_and_their_grants_after_recon" {
  command = plan

  variables {
    pipeline_enabled = true
    app_wiring       = var.wired_apps
  }

  # Both switches flip together: the app is on, and a blank access group now fails closed.
  assert {
    condition = (
      { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["PIPELINE_ENABLED"] == "true"
      && { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }["REQUIRE_ACCESS_GROUPS"] == "true"
    )
    error_message = "a console with a second app deployed must render PIPELINE_ENABLED=true and REQUIRE_ACCESS_GROUPS=true"
  }

  # The app variables are the TAIL of the environment: alpha's in the order alpha listed them
  # (ZULU_TABLE before ALPHA_BUCKET -- a sort would have swapped them), then beta's, each with its own
  # value. This is the enabled-case golden: an app's exported list lands untouched, so the console a
  # deployment rendered when it built an app's variables itself (the pipeline's, in modules/deal-pipeline's
  # export order) is the console it renders through app_wiring -- the same task definition revision.
  assert {
    condition = jsonencode(slice(
      jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment,
      length(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment) - 3,
      length(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment),
      )) == jsonencode([
      { name = "ZULU_TABLE", value = "alpha-zulu" },
      { name = "ALPHA_BUCKET", value = "alpha-assets" },
      { name = "BETA_QUEUE", value = "beta-queue" },
    ])
    error_message = "the enabled apps' variables must be appended last, in app order and then exactly in each app's export order (never re-sorted), with their values"
  }

  # The same property stated against the input: the tail IS the enabled apps' lists concatenated,
  # byte for byte, so nothing this module does to them can change a deployed task definition.
  assert {
    condition = jsonencode(slice(
      jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment,
      length(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment) - 3,
      length(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment),
    )) == jsonencode(concat(var.wired_apps.alpha.environment, var.wired_apps.beta.environment))
    error_message = "the enabled apps' variables must reach the task definition exactly as exported: the same entries, the same order, nothing re-sorted or re-shaped"
  }

  # Everything BEFORE them is the recon-only environment. It differs from the golden rendering in
  # exactly two VALUES -- PIPELINE_ENABLED and REQUIRE_ACCESS_GROUPS, the console-level switches that
  # pipeline_enabled = true flips (asserted above) -- so with those two read back as "false" it must
  # hash to the golden: same names, same values, same order, nothing else moved.
  assert {
    condition = sha256(jsonencode([
      for e in slice(
        jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment,
        0,
        length(jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment) - 3,
      ) : contains(["PIPELINE_ENABLED", "REQUIRE_ACCESS_GROUPS"], e.name) ? { name = e.name, value = "false" } : e
    ])) == var.golden_recon_environment_sha256
    error_message = "enabling apps must leave the recon variables ahead of theirs byte-for-byte unchanged, apart from the two switch values"
  }

  assert {
    condition     = !contains([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name], "GAMMA_TABLE")
    error_message = "a disabled app's variables must not reach the task environment when other apps are enabled"
  }

  # Only once each: a duplicated name in an ECS environment is last-one-wins with no warning.
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]) == length(distinct([for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name]))
    error_message = "no environment variable name may appear twice in the task definition"
  }

  # The app statements are the TAIL of the policy (no console-settings prefix here, so nothing follows
  # them), in app order and then in the order each app exported them; gamma's is absent.
  assert {
    condition = [
      for s in slice(
        jsondecode(aws_iam_role_policy.ecs_task.policy).Statement,
        length(jsondecode(aws_iam_role_policy.ecs_task.policy).Statement) - 3,
        length(jsondecode(aws_iam_role_policy.ecs_task.policy).Statement),
      ) : s.Sid
    ] == ["AlphaTable", "AlphaList", "BetaQueue"]
    error_message = "the enabled apps' statements must be the last three in the policy, in app order then export order"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s if can(s.Sid)]) == 3
    error_message = "exactly the enabled apps' statements may carry into the policy; a disabled app's must not"
  }

  # Every statement WITHOUT a Sid is recon's, and together they are the recon-only policy, byte for
  # byte: the same golden hash, re-encoded without the app statements.
  assert {
    condition = sha256(jsonencode({
      Version   = "2012-10-17"
      Statement = [for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s if !can(s.Sid)]
    })) == var.golden_recon_policy_sha256
    error_message = "enabling apps must leave every recon statement byte-for-byte unchanged"
  }

  # A statement lands exactly as the app wrote it: the string Resource stays a string and the
  # Condition survives the JSON round trip.
  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s if try(s.Sid, "") == "AlphaList"]).Resource == "arn:aws:s3:::alpha-assets"
      && one([for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s if try(s.Sid, "") == "AlphaList"]).Condition.StringLike["s3:prefix"] == ["skills/*"]
      && one([for s in jsondecode(aws_iam_role_policy.ecs_task.policy).Statement : s if try(s.Sid, "") == "AlphaTable"]).Resource == ["arn:aws:dynamodb:us-east-1:123456789012:table/alpha-zulu"]
    )
    error_message = "app statements must land in the policy exactly as exported: string and list Resources, and Conditions, intact"
  }
}

# The recon root renders a laptop's .env.local (output frontend_env_local) from this output rather
# than from its own copy of the wiring, so the output has to BE the container environment: every
# name, every value, nothing else -- with apps enabled, so both halves are covered.
run "task_environment_output_is_the_container_environment" {
  command = plan

  variables {
    pipeline_enabled = true
    app_wiring       = var.wired_apps
  }

  assert {
    condition     = output.task_environment == { for e in jsondecode(aws_ecs_task_definition.frontend.container_definitions)[0].environment : e.name => e.value }
    error_message = "task_environment must be exactly the container's environment as a name => value map"
  }

  # The names the root indexes from the map: a recon variable, the token that makes the output
  # sensitive, the console-wide prefix, the two switches, the auth names (the Cognito three among them
  # -- the root writes both the runtime and the NEXT_PUBLIC_ copy of each into .env.local from these),
  # and the enabled apps' variables.
  assert {
    condition = length(setsubtract(
      toset([
        "CASES_TABLE", "EMAIL_CONFIRMATION_TOKEN", "CONSOLE_SETTINGS_PREFIX",
        "PIPELINE_ENABLED", "REQUIRE_ACCESS_GROUPS",
        "AUTH_PROVIDER", "AUTH_GROUPS_CLAIM", "OKTA_ISSUER", "OKTA_CLIENT_ID",
        "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_HOSTED_UI",
        "ALPHA_BUCKET", "BETA_QUEUE", "ZULU_TABLE",
      ]),
      toset(keys(output.task_environment)),
    )) == 0
    error_message = "task_environment must carry the recon, auth, console-wide and app names the root's frontend_env_local output indexes"
  }
}

# The two URLs a Cognito app client must have registered for this deployment. The root feeds them
# straight into the callback patch, so a wrong path here is a redirect_mismatch at sign-in with nothing
# in the plan to explain it -- and the sign-out URL in particular is easy to get wrong, because the
# obvious "origin with a trailing slash" does not match what the browser sends.
run "the_cognito_urls_to_register_follow_the_frontend_route_contract" {
  command = plan

  variables {
    auth_provider = "cognito"
  }

  # private_vpc = true in this file, so the public host is the ALB's DNS name rather than a CloudFront
  # domain. The path contract is the same either way, which is what is being pinned.
  assert {
    condition     = endswith(output.cognito_callback_url, "/callback") && startswith(output.cognito_callback_url, "https://")
    error_message = "cognito_callback_url must be an https URL ending in /callback, the path the console serves the redirect on; got ${output.cognito_callback_url}"
  }

  # No path and no trailing slash: cognito-pkce.ts sends window.location.origin as logout_uri and
  # Cognito compares the string exactly.
  assert {
    condition     = output.cognito_logout_url == trimsuffix(output.cognito_callback_url, "/callback")
    error_message = "cognito_logout_url must be the same origin as the callback with no path and no trailing slash; got ${output.cognito_logout_url}"
  }

  # A pinned redirect wins, so a console reachable on a custom domain registers that domain rather
  # than the distribution's.
  assert {
    condition     = output.cognito_callback_url != ""
    error_message = "cognito_callback_url must be non-empty when auth_provider = cognito"
  }
}

# ...and both are empty for the other two providers, so an Okta or Entra deployment's root renders no
# Cognito checklist line and passes no URLs to a patch it does not run.
run "the_cognito_urls_are_empty_for_the_other_providers" {
  command = plan

  assert {
    condition     = output.cognito_callback_url == "" && output.cognito_logout_url == ""
    error_message = "with auth_provider = entra (this file's default) both Cognito URL outputs must be empty"
  }
}

# A pinned callback URL must end in /callback. Anything else is refused by the frontend when the module
# loads, so it is refused here at plan instead -- where the message can name the variable. A trailing
# slash is the case worth pinning: Cognito compares the registered string exactly, so ".../callback/"
# and ".../callback" are different URLs.
run "a_pinned_cognito_redirect_uri_with_the_wrong_path_fails_at_plan" {
  command = plan

  variables {
    auth_provider        = "cognito"
    cognito_redirect_uri = "https://console.example.test/callback/"
  }

  expect_failures = [var.cognito_redirect_uri]
}

# The Okta callback path ENDS in "/callback", so the shape rule above accepts it. Copying
# okta_redirect_uri into this variable is the obvious mistake and it applies cleanly, which is why
# there is a second validation for exactly this string.
run "the_okta_callback_path_is_refused_as_a_cognito_redirect_uri" {
  command = plan

  variables {
    auth_provider        = "cognito"
    cognito_redirect_uri = "https://console.example.test/login/callback"
  }

  expect_failures = [var.cognito_redirect_uri]
}

run "a_pinned_cognito_redirect_uri_is_used_verbatim" {
  command = plan

  variables {
    auth_provider        = "cognito"
    cognito_redirect_uri = "https://console.example.test/callback"
  }

  assert {
    condition     = output.cognito_callback_url == "https://console.example.test/callback"
    error_message = "a pinned cognito_redirect_uri must be the URL to register, not the derived host; got ${output.cognito_callback_url}"
  }
}

# An app that exports a recon name would silently take that name over in the container. Refused at
# plan, on the task definition, naming the variable.
run "an_app_variable_that_reuses_a_recon_name_fails_at_plan" {
  command = plan

  variables {
    app_wiring = {
      clash = {
        enabled         = true
        environment     = [{ name = "ASSETS_BUCKET", value = "not-recons-bucket" }]
        task_statements = []
      }
    }
  }

  expect_failures = [aws_ecs_task_definition.frontend]
}

# Two apps exporting one name are refused the same way, whichever order the map sorts them into.
run "two_apps_exporting_one_variable_fail_at_plan" {
  command = plan

  variables {
    app_wiring = {
      alpha = merge(var.wired_apps.alpha, { environment = [{ name = "SHARED_TABLE", value = "alpha" }] })
      beta  = merge(var.wired_apps.beta, { environment = [{ name = "SHARED_TABLE", value = "beta" }] })
    }
  }

  expect_failures = [aws_ecs_task_definition.frontend]
}
