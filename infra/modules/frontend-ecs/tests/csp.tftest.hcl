# Run from this module's directory: `terraform init && terraform test`.
#
# The CloudFront response-headers policy, and specifically the `connect-src` directive of its CSP.
# Separate from app_wiring.tftest.hcl because that file runs private_vpc = true for every run, which
# gives the policy `count = 0` -- there is no CloudFront in private mode -- so nothing there can see
# this header at all. These runs are therefore public-mode (the module default) and assert nothing
# else.
#
# What is being pinned: the browser half of the Cognito sign-in is a cross-origin `fetch` to
# `https://<hosted-ui>/oauth2/token` (the code-for-token exchange and every silent refresh in
# src/lib/auth/cognito-pkce.ts). `connect-src 'self'` refuses it, and the browser reports a CSP
# violation rather than an auth failure -- so a missing entry here presents as "sign-in is broken"
# with the cause visible only in the devtools console. It was missing.
#
# The second run is the other half of the same guarantee: an Okta or Entra deployment must get the
# directive it got before Cognito existed, byte for byte, because a CSP source nothing uses is not
# free -- it reads as evidence that the app talks to that host.

mock_provider "aws" {
  override_during = plan

  override_resource {
    target = aws_ecr_repository.frontend
    values = {
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/frontend-test"
    }
  }

  # dns_name + arn together: an override_resource replaces the whole computed set, so omitting the ARN
  # hands aws_lb_listener.http a placeholder its own validation rejects at plan.
  override_resource {
    target = aws_lb.this
    values = {
      dns_name = "frontend-test-000000.us-east-1.elb.amazonaws.com"
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/frontend-test/0000000000000000"
    }
  }
}

mock_provider "null" {}

variables {
  name_prefix = "frontend-test"
  region      = "us-east-1"
  account_id  = "123456789012"
  # A directory that does not exist: fileset() yields nothing, so no run hashes the real frontend tree.
  frontend_dir = "tests/fixtures/no-such-frontend"
  vpc_id       = "vpc-00000000000000000"

  recon_api_base = "https://api.example.test"

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
}

# The literal each run below matches against is the directive an Okta or Entra deployment renders, and
# it is the SAME string this module rendered before the Cognito path existed: the guarantee is that
# choosing an external IdP changes nothing about the response headers. It is repeated in full in every
# assertion rather than factored into a local because a .tftest.hcl file cannot declare one -- and a
# spelled-out expectation is what makes a diff to this directive visible in a review.

run "the_hosted_ui_is_a_connect_src_when_the_console_signs_in_with_cognito" {
  command = plan

  variables {
    auth_provider     = "cognito"
    cognito_hosted_ui = "login.example.test"
    cognito_client_id = "client"
  }

  assert {
    condition = strcontains(
      aws_cloudfront_response_headers_policy.security[0].security_headers_config[0].content_security_policy[0].content_security_policy,
      "connect-src 'self' https://*.okta.com https://login.microsoftonline.com https://login.example.test;"
    )
    error_message = "the hosted-UI origin must be appended to connect-src, or the code-for-token POST and every silent refresh are blocked by the browser"
  }

  # No frame-src allowance came with it. Nothing frames the hosted UI, and the module's own comment
  # explains at length why an iframe allowance here is the wrong answer to a CSP console error.
  assert {
    condition = strcontains(
      aws_cloudfront_response_headers_policy.security[0].security_headers_config[0].content_security_policy[0].content_security_policy,
      "frame-src 'self' blob:"
    )
    error_message = "frame-src must stay 'self' blob: -- the Cognito host belongs in connect-src only"
  }
}

# A value pasted WITH its scheme (the console shows the domain as a URL, and cognito-pkce.ts tolerates
# the prefix) must not render `https://https://...`, which browsers drop silently -- leaving the exact
# breakage the directive exists to prevent, but now invisible in the plan too.
run "a_hosted_ui_pasted_with_its_scheme_renders_one_scheme" {
  command = plan

  variables {
    auth_provider     = "cognito"
    cognito_hosted_ui = "https://login.example.test/"
    cognito_client_id = "client"
  }

  assert {
    condition = strcontains(
      aws_cloudfront_response_headers_policy.security[0].security_headers_config[0].content_security_policy[0].content_security_policy,
      "connect-src 'self' https://*.okta.com https://login.microsoftonline.com https://login.example.test;"
    )
    error_message = "cognito_hosted_ui must be normalized to a bare host before it becomes a CSP source"
  }
}

# The other two providers: byte-identical to the pre-Cognito directive, with nothing appended and no
# trailing separator.
run "the_directive_is_unchanged_for_okta_and_entra" {
  command = plan

  variables {
    auth_provider = "okta"
    okta_issuer   = "https://example.okta.test/oauth2/default"
  }

  assert {
    condition = strcontains(
      aws_cloudfront_response_headers_policy.security[0].security_headers_config[0].content_security_policy[0].content_security_policy,
      "connect-src 'self' https://*.okta.com https://login.microsoftonline.com;"
    )
    error_message = "an Okta deployment must render the connect-src it rendered before Cognito existed"
  }
}
