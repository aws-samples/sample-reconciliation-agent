# Run from this module's directory: `terraform init && terraform test`.
#
# Plan-only under a MOCKED AWS provider: no pool is created, no credentials are read, and the region
# data source is overridden so the hosted-UI host is known at plan time.
#
# What is under test is the console's contract with this pool, in the three places a mistake would be
# invisible until someone tried to sign in:
#   * the five groups exist, with the configured names and nothing else — the console resolves access
#     per request from the group claim, so a renamed or missing group silently denies an app;
#   * the app client is PUBLIC with no secret and code flow only — a secret or an implicit grant would
#     both "work" in a browser and both be wrong;
#   * a blank or whitespace group name fails the plan, so a deployment cannot create a group called ""
#     that no token can ever carry.

mock_provider "aws" {
  override_data {
    target = data.aws_region.current
    values = {
      region = "us-east-1"
    }
  }
}

variables {
  name_prefix      = "auth-test"
  hosted_ui_prefix = "auth-test-login"

  callback_urls = ["https://console.example.test/callback", "http://localhost:3000/callback"]
  logout_urls   = ["https://console.example.test", "http://localhost:3000"]
}

run "the_five_console_groups_are_created_with_the_configured_names" {
  command = plan

  # The role keys are the console's, spelled out: a typo in a key would still create a group and the
  # root would then hand the console a name for a group that does not exist.
  assert {
    condition = toset(keys(aws_cognito_user_group.console)) == toset([
      "recon-access", "recon-admin", "pipeline-access", "pipeline-admin", "console-admin",
    ])
    error_message = "exactly the five console roles must be created, keyed as the console reads them; got ${jsonencode(sort(keys(aws_cognito_user_group.console)))}"
  }

  # Defaults, so a first apply is coherent without an operator naming anything.
  assert {
    condition = output.group_names == {
      "recon-access"    = "recon-users"
      "recon-admin"     = "recon-admins"
      "pipeline-access" = "deal-desk"
      "pipeline-admin"  = "deal-desk-admins"
      "console-admin"   = "console-admins"
    }
    error_message = "the default group names must be the five generic role names the root also hands the console; got ${jsonencode(output.group_names)}"
  }

  assert {
    condition     = output.group_names_list == tolist(["console-admins", "deal-desk", "deal-desk-admins", "recon-admins", "recon-users"])
    error_message = "group_names_list must be the same five names, sorted; got ${jsonencode(output.group_names_list)}"
  }

  # Every group carries a description: the Cognito console is where an operator adds people, and an
  # undescribed group there is a name with no clue what granting it does.
  assert {
    condition     = alltrue([for group in aws_cognito_user_group.console : trimspace(group.description) != ""])
    error_message = "every console group must carry a description explaining what membership grants"
  }
}

run "renaming_a_group_renames_only_that_group" {
  command = plan

  variables {
    pipeline_admin_group = "trading-desk-managers"
  }

  assert {
    condition     = output.group_names["pipeline-admin"] == "trading-desk-managers"
    error_message = "a renamed group must take the variable's value"
  }

  assert {
    condition     = output.group_names["recon-access"] == "recon-users" && output.group_names["console-admin"] == "console-admins"
    error_message = "renaming one group must leave the other four at their own variables' values"
  }
}

run "the_spa_client_is_public_with_no_secret_and_code_flow_only" {
  command = plan

  # No secret, because the code runs in a browser. PKCE is what replaces it.
  assert {
    condition     = aws_cognito_user_pool_client.spa.generate_secret == false
    error_message = "the SPA client must be public: a client secret in a browser bundle is readable by anyone who opens the network tab"
  }

  # "code" and nothing else. An implicit grant would return tokens in the URL fragment, where every
  # proxy log and Referer header along the way could keep a copy.
  assert {
    condition     = aws_cognito_user_pool_client.spa.allowed_oauth_flows == toset(["code"])
    error_message = "allowed_oauth_flows must be exactly [\"code\"] — no implicit grant, no client_credentials"
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.allowed_oauth_scopes == toset(["openid", "email", "profile"])
    error_message = "allowed_oauth_scopes must be exactly openid, email and profile: the console needs an identity and an address, nothing more"
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.allowed_oauth_flows_user_pool_client == true
    error_message = "allowed_oauth_flows_user_pool_client must be true or the hosted UI refuses the authorize request"
  }

  # Refresh only. No SRP and no USER_PASSWORD flow: the only place a password is ever typed is the
  # hosted UI on Cognito's own domain, so an XSS in the console cannot become a credential-stuffing
  # endpoint against the pool.
  assert {
    condition     = aws_cognito_user_pool_client.spa.explicit_auth_flows == toset(["ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "explicit_auth_flows must be exactly [\"ALLOW_REFRESH_TOKEN_AUTH\"]; got ${jsonencode(aws_cognito_user_pool_client.spa.explicit_auth_flows)}"
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.supported_identity_providers == toset(["COGNITO"])
    error_message = "supported_identity_providers must default to the pool's own directory; a federated provider has to be added to this list explicitly"
  }

  assert {
    condition     = aws_cognito_user_pool_client.spa.prevent_user_existence_errors == "ENABLED" && aws_cognito_user_pool_client.spa.enable_token_revocation == true
    error_message = "the client must not let the sign-in form enumerate users, and sign-out must actually revoke the refresh token"
  }

  # The URLs the root composed reach the client verbatim: Cognito compares them exactly, so a dropped
  # or rewritten entry is a redirect_mismatch at sign-in with nothing in the plan to explain it.
  assert {
    condition = (
      aws_cognito_user_pool_client.spa.callback_urls == toset(["https://console.example.test/callback", "http://localhost:3000/callback"])
      && aws_cognito_user_pool_client.spa.logout_urls == toset(["https://console.example.test", "http://localhost:3000"])
    )
    error_message = "callback_urls and logout_urls must reach the client exactly as passed in"
  }
}

run "the_pool_is_admin_create_only_with_a_real_password_policy" {
  command = plan

  # No self sign-up is what lets the sample ship a real login without shipping open registration.
  assert {
    condition     = aws_cognito_user_pool.this.admin_create_user_config[0].allow_admin_create_user_only == true
    error_message = "the pool must be admin-create-only: a stranger who finds the hosted UI must have no way to create an account"
  }

  assert {
    condition = (
      aws_cognito_user_pool.this.password_policy[0].minimum_length >= 12
      && aws_cognito_user_pool.this.password_policy[0].require_lowercase
      && aws_cognito_user_pool.this.password_policy[0].require_uppercase
      && aws_cognito_user_pool.this.password_policy[0].require_numbers
      && aws_cognito_user_pool.this.password_policy[0].require_symbols
    )
    error_message = "the password policy must require at least 12 characters and all four character classes"
  }

  assert {
    condition     = aws_cognito_user_pool.this.username_attributes == toset(["email"])
    error_message = "email must be the sign-in name, so an operator creates a user by address and the token carries an email claim"
  }

  # INACTIVE by default so the sample can be destroyed again; ACTIVE is a deliberate choice.
  assert {
    condition     = aws_cognito_user_pool.this.deletion_protection == "INACTIVE"
    error_message = "deletion protection must default to INACTIVE so `terraform destroy` can tear the sample down; set it ACTIVE deliberately"
  }
}

run "the_hosted_ui_host_is_composed_from_the_prefix_and_the_region" {
  command = plan

  # The console is handed this string as COGNITO_HOSTED_UI, so a wrong shape (a scheme, a trailing
  # slash, the wrong region) is a sign-in that never reaches Cognito.
  assert {
    condition     = output.hosted_ui_domain == "auth-test-login.auth.us-east-1.amazoncognito.com"
    error_message = "hosted_ui_domain must be <prefix>.auth.<region>.amazoncognito.com with no scheme and no trailing slash; got ${output.hosted_ui_domain}"
  }

  assert {
    condition     = output.hosted_ui_url == "https://auth-test-login.auth.us-east-1.amazoncognito.com"
    error_message = "hosted_ui_url must be the same host as an https origin; got ${output.hosted_ui_url}"
  }

  assert {
    condition     = output.hosted_ui_prefix == "auth-test-login"
    error_message = "hosted_ui_prefix must echo the prefix the deployment claimed"
  }
}

# A blank name would create a group called "" — an apply that succeeds and an app nobody can reach,
# because no token can carry an empty group. Refused at plan, on the variable the operator set.
run "a_blank_group_name_fails_at_plan" {
  command = plan

  variables {
    recon_access_group = ""
  }

  expect_failures = [var.recon_access_group]
}

# Whitespace is blank too, and Cognito's GroupName rejects spaces anywhere — so "Recon Analysts" is
# refused here rather than at apply, where the message names an API field instead of a variable.
run "a_whitespace_group_name_fails_at_plan" {
  command = plan

  variables {
    recon_admin_group    = "   "
    pipeline_admin_group = "Deal Desk Admins"
  }

  expect_failures = [var.recon_admin_group, var.pipeline_admin_group]
}

# Every one of the five is guarded, not just the two above: a validation copied onto four variables
# and forgotten on the fifth is exactly the kind of gap that only shows up in production.
run "every_group_variable_refuses_a_blank_name" {
  command = plan

  variables {
    recon_access_group    = ""
    recon_admin_group     = ""
    pipeline_access_group = ""
    pipeline_admin_group  = ""
    console_admin_group   = ""
  }

  expect_failures = [
    var.recon_access_group,
    var.recon_admin_group,
    var.pipeline_access_group,
    var.pipeline_admin_group,
    var.console_admin_group,
  ]
}

# Cognito reserves these substrings in a domain prefix and rejects the domain mid-apply. Named at
# plan, because "recon-cognito-dev" reads like a perfectly good prefix.
run "a_reserved_word_in_the_hosted_ui_prefix_fails_at_plan" {
  command = plan

  variables {
    hosted_ui_prefix = "auth-test-cognito"
  }

  expect_failures = [var.hosted_ui_prefix]
}

# Cognito accepts plain http ONLY for localhost. Any other http:// callback applies cleanly and then
# fails every sign-in, so it is refused here.
run "a_plain_http_callback_on_a_real_host_fails_at_plan" {
  command = plan

  variables {
    callback_urls = ["http://console.example.test/callback"]
  }

  expect_failures = [var.callback_urls]
}

# A client with no callback URL can never complete a sign-in.
run "an_empty_callback_list_fails_at_plan" {
  command = plan

  variables {
    callback_urls = []
  }

  expect_failures = [var.callback_urls]
}
