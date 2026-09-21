# Intake HTTP API

> Detail page for the [Reconciliation Workflow Agent](../README.md).

One API Gateway **HTTP API** (`recon-dev-api`), one JWT authorizer, two routes. It is the platform's
only synchronous front door: writing a `ReconItem` into `recon-dev-items` is what opens a case, and
`POST /items` is the one place a `ReconItem` is constructed. The IDP hook is the other entry point and
it never builds one — it writes notices as evidence.

The surface is deliberately this small. Case decisions (queue / approve / reject) are **not** here:
they run in the frontend's same-origin BFF routes acting through the egress gateway's platform tools,
so there is exactly one human-in-the-loop code path. A JWT-fronted decision route would create a
second one to keep in step. `infra/modules/api` says so in its header comment; don't add routes there
without reading it.

## Resources

Split across two Terraform modules that share one API.

| Resource            | Name                                                   | Declared in                                                                                     |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| HTTP API            | `recon-dev-api`                                        | `infra/modules/intake/main.tf` (`aws_apigatewayv2_api.http`)                                    |
| JWT authorizer      | `recon-dev-oidc-jwt` (issuer-agnostic)                 | `infra/modules/intake/main.tf:121`                                                              |
| Stage               | `$default`, `auto_deploy = true`                       | `infra/modules/intake/main.tf`                                                                  |
| Route `POST /items` | → `recon-dev-intake` Lambda                            | `infra/modules/intake/main.tf:140`                                                              |
| Route `GET /skills` | → `recon-dev-skills-bff` Lambda                        | `infra/modules/api/main.tf:118`                                                                 |
| Access logs         | `/aws/apigateway/recon-dev-intake`, 365-day retention  | `infra/modules/intake/main.tf`                                                                  |
| Private REST API    | `recon-dev-intake-private` — `private_vpc = true` only | `infra/modules/intake/private_api.tf` (see [below](#reaching-it-from-a-private-vpc-deployment)) |

`modules/api` owns no API of its own — it takes `api_id`, `authorizer_id` and `api_execution_arn` as
inputs and hangs a route on the intake module's API (`infra/environments/recon/main.tf:517-519`). So
`modules/intake` must apply first, and destroying it takes `GET /skills` with it.

Both Lambdas are `python3.12`, both come out of the single shared deployment zip built by
`modules/lambda-package`, and both are VPC-attached to the two private subnets unconditionally —
`local.vpc_subnets` is wired straight from `module.network.private_subnet_ids`, not gated on
`private_vpc`.

## Authorization

The HTTP API validates the same OIDC provider the console signs in against, and the private REST API (below) uses SigV4.

```hcl
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.name_prefix}-oidc-jwt"

  jwt_configuration {
    audience = [var.jwt_audience]   # local.oidc_audience
    issuer   = var.jwt_issuer       # local.oidc_issuer
  }
}
```

A v2 JWT authorizer validates any OIDC issuer. Issuer and audience are
derived from `auth_provider` in **one** place, `infra/environments/recon/main.tf`'s `oidc_*` locals,
using the same derivation `chatbot-app/frontend/src/lib/api-auth.ts` performs for the BFF, so the API
and the BFF accept exactly the same tokens by construction:

| `auth_provider`         | `issuer`                                               | `audience`               |
| ----------------------- | ------------------------------------------------------ | ------------------------ |
| `cognito` (the default) | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | the pool's SPA client id |
| `okta`                  | `okta_issuer`                                          | `okta_client_id`         |
| `entra`                 | `https://login.microsoftonline.com/<tenant>/v2.0`      | `entra_client_id`        |

The `cognito` row is the **console's own user pool** (`module.console_auth`), the one operators sign in
through — so by default this API and the console validate one identity provider, not two. Note the
issuer is the `cognito-idp` endpoint, **not** the hosted-UI domain the browser is redirected to; the
JWKS lives under the former.

Entra's **v2.0** issuer specifically: a v1 token (`sts.windows.net`) fails this check by design, which
matches `api-auth.ts`. An unset `auth_provider` does not reach this module's validation at all — the
root resolves it to `cognito`, so an unconfigured deployment fails the plan on the required
`cognito_hosted_ui_prefix` instead, naming the variable that is missing rather than authorizing against
nothing.

Both routes set `authorization_type = "JWT"` with this authorizer id, so **every route on this API is
protected** and there is no unauthenticated route to accidentally inherit.

What it checks, and what it does not:

- **Issuer and audience**, as above. API Gateway matches the token's `aud` claim, or `client_id` when
  `aud` is absent — so an ID token and an access token from the same OIDC client both pass.
- **No scopes.** `jwt_configuration` declares none, so the authorizer proves only "minted by this
  provider for this client", never "allowed to do this". There is no per-caller authorization on this
  API at all — no group check, no admin gate. Anyone holding a valid token for the app can submit items.
  The console's own admin gate (`RECON_ADMIN_GROUP`) applies to the BFF, not here.
- Signature, `exp`/`nbf` and `iss`/`aud` are validated by API Gateway before the Lambda runs. A
  rejected token never reaches Python, so a 401 has no Lambda log line to go with it — look in the
  access log group instead.
- **JWKS is fetched by API Gateway**, from AWS-managed infrastructure rather than from this VPC. That is
  why this authorizer keeps working in a no-NAT private deployment, and it is exactly the reason the
  private REST API uses SigV4 instead of a Lambda authorizer doing the same job from inside the VPC.

### Getting a token

The same token the console holds — a user-pool ID token by default, or an Okta or Entra one when
`auth_provider` names those. `/api/recon/*` and `POST /items` accept the identical token, so anything
that can call the BFF can call this API:

1. **From the browser session** — sign in to the console and reuse its bearer token. `reconFetch`
   attaches it for BFF calls; the same value works here.
2. **Machine-to-machine** — an Okta client-credentials grant on the same authorization server, or an
   Entra app-only token, whose `aud` is the configured client id. On a Cognito deployment this needs a
   SECOND app client, one with a secret, plus a resource server for the scope — the console's own
   client has no secret, deliberately, and its client id is the only `aud` this authorizer accepts, so
   plan for a variable rather than assuming the console's client will do.
3. **Skip the API.** For local verification the cheaper path is invoking the Lambda directly with a
   synthetic API Gateway event — what the console's BFF does (below), and it fires the real Tier-1
   stream.

## `POST /items`

Handler: `backend/intake/handler.py` → `backend.intake.handler.handle`, 30 s timeout,
`ITEMS_TABLE=recon-dev-items`.

### Request body

The smallest payload that exercises the whole pipeline — a two-sided cash break that Tier-1
evaluates, fails to match, and escalates to the agent:

```json
{
  "domain": "cash",
  "items": [
    {
      "item_id": "manual-scenario1-1",
      "sides": [
        {
          "name": "bank",
          "attributes": {
            "amount": "12500.00",
            "currency": "USD"
          }
        },
        {
          "name": "ledger",
          "attributes": {
            "amount": "0.00",
            "currency": "USD"
          }
        }
      ],
      "source_refs": ["manual-submission"]
    }
  ]
}
```

Everything above except `currency` and `source_refs` is load-bearing. The two tables say what may be
omitted; [What the values steer](#what-the-values-steer) says what happens when you change the rest.

#### Envelope

Two keys, both read by subscript, so a missing one is a `400` rather than a default:

| Key      | Required | Notes                                                                                             |
| -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `domain` | yes      | Non-empty string, applied to **every** item in the batch. There is no per-item override.          |
| `items`  | yes      | Non-empty list. An empty list is rejected explicitly: `400 {"error": "items must be non-empty"}`. |

#### Item

Each element of `items` is validated as a `ReconItem` (`backend/recon_core/schema.py`):

| Field         | Required | Default | Notes                                                                                                                               |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `item_id`     | yes      | —       | Any string. It is the table's partition key **and** the idempotency key, so it decides whether a resubmission writes or is skipped. |
| `sides`       | yes      | —       | List of `{name, attributes}`. The value may be `[]`, but the key itself cannot be omitted — that is a `missing` validation error.   |
| `source_refs` | no       | `[]`    | List of strings, provenance only. Nothing branches on the values; `"manual-submission"` above is a human label, not a magic token.  |
| `attributes`  | no       | `{}`    | Item-level passthrough bag. Reserved keys below.                                                                                    |
| `tier`        | no       | `1`     | Recorded on the item. Tier-1 runs off the stream regardless of what is set here.                                                    |
| `domain`      | never    | —       | Envelope-only. Putting it on the item is a `400` — see the pitfalls below.                                                          |

#### Side

| Field        | Required | Default | Notes                                                                                            |
| ------------ | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `name`       | yes      | —       | Free-form label. `bank` / `ledger` is convention, not a contract; no rule reads it.              |
| `attributes` | no       | `{}`    | `dict[str, str]` — every value must be a JSON **string**. Which keys matter is the next section. |

### What the values steer

Three fields change what the platform does. The rest is passthrough or a label.

**`domain` selects the Tier-1 rule, and `cash` is the only rule that exists.** The rule set is
`_RULES` in `backend/tier1/handler.py:22`, a single entry: `cash` → match on `amount`, tolerance
`0.05`, auto-clear category `amount-match`. `reconcile()` does `rules.get(item.domain)`, so any other
value returns the `no_rule` escalation immediately — no comparison is attempted, the item opens
`PENDING` and waits for the next Tier-2 map run — a scheduled poll, so up to its interval. This is why the domain is `cash` and not a business label
like `unapplied-cash`: the latter is accepted, written, and silently skips the deterministic tier.
Change it only alongside a new `_RULES` entry.

**The number of `sides` picks the route, and three counts behave differently.**

| `side_count` | Tier-1 does                                            | Break-type hint                         |
| ------------ | ------------------------------------------------------ | --------------------------------------- |
| exactly `2`  | compares the rule's `match_attr` across the two sides  | `record-match-review`                   |
| `0`          | general-ledger lookup, when `GL_QUERY_FUNCTION` is set | `ledger-status-resolution`              |
| `1`, or `3`+ | nothing — `side_count` escalation                      | none; the agent classifies from scratch |

A sides-less item is deliberately valid — an item derived from a document has no ledger side yet —
so "accepted" does not imply "reconcilable".

**`attributes.amount` on both sides is the comparison, and it is the only attribute Tier-1 reads.**
It must be present on both sides (otherwise `missing_match_attr`) and parse as a `Decimal`
(otherwise `unparseable_amount`; an empty string or `"n/a"` lands here, not in a crash). Within
`0.05` the item auto-clears as `amount-match` and never reaches the LLM; outside it, `tolerance_miss`.
The sample's `12500.00` vs `0.00` differ by 12500, so it escalates — change the ledger side to
`12500.04` and the identical payload auto-clears instead. The comparison is `abs(a - b)`, so side
order is irrelevant; it only decides which side is labelled `side_a` in the stored match evidence.

**Everything else in a side's `attributes` is invisible to Tier-1**, including `currency` — two sides
in different currencies still auto-clear on a matching number. Extra attributes earn their keep at
Tier-2: `record-match-review` compares account name, amount and entry direction, so adding
`account_name` (a label the skill's fund-alias table can resolve) and `entry_type` (`CREDIT` /
`DEBIT`) gives the agent something to investigate. `amount` and `currency` alone is a valid break and
a thin case.

### Pitfalls in this shape

Verified against the live schema, and each one fails in a way that does not name its cause:

- **`domain` belongs on the envelope, not the item.** The handler does
  `ReconItem(domain=domain, **raw)`, so an item that also carries `domain` is a duplicate keyword
  argument — a `TypeError`, caught and returned as `400 invalid item`, which reads like a schema
  problem rather than a misplaced key.
- **Side attribute values must be quoted.** `ReconSide.attributes` is `dict[str, str]` and pydantic v2
  does not coerce numbers to strings, so `"amount": 12500.00` fails with `string_type`. Quote every
  value.
- **Item-level `attributes` follows the opposite rule.** It is a bare `dict`, so numbers and nested
  objects are accepted there. The two bags are not interchangeable, and the difference is easy to
  carry the wrong way.
- **Unknown item keys are dropped silently.** The model does not forbid extras, so a misspelled field
  — `"Tier": 2`, `"item-id"` — is discarded without an error, and `item_id` then fails as _missing_
  rather than as _misspelled_.
- **Attributes the two sides disagree about vanish from the break record.** `break_record` omits a
  conflicting field entirely rather than letting side order decide, so in the sample above only
  `currency` reaches the break-type rules; `amount` is dropped. Any rule you add keyed on a field
  that legitimately differs between sides can therefore never fire.
- **Some `attributes` keys are written by the platform and will be overwritten.**
  `tier1_escalation_reason`, `tier1_break_type` and `gl_candidates` are set on the escalation path;
  `idp_class`, `idp_attributes` and `idp_sections` are the IDP hook's. Do not supply them.
- **Nothing records the submitter.** There is no actor field on `ReconItem`, which is why the BFF route
  in front of this one doesn't bother resolving the caller's identity.

### Responses

| Status | Body               | Means                                                                                     |
| ------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `202`  | `{"written": n}`   | Accepted. `n` counts **newly created** rows, not items submitted                          |
| `400`  | `{"error": "..."}` | Malformed envelope, empty `items`, or any invalid item — see all-or-nothing below         |
| `401`  | API Gateway's      | Missing, malformed, expired or wrong-audience token; never reaches the Lambda             |
| `500`  | API Gateway's      | Unhandled exception in the handler (e.g. a DynamoDB failure that isn't a condition check) |

Two semantics worth stating explicitly, because both were deliberate:

**The whole batch is validated before any of it is written.** Constructing the items inside the write
loop would let a bad item 4 escape as an unhandled exception with items 1-3 already written and Tier-1
already running on them — the caller gets a 502 and cannot tell "rejected" from "half-accepted", and
the retry then reports `written: 0`, which is indistinguishable from "nothing happened".

**Resubmission is idempotent, and `written` is how you can tell.** `ItemStore.put_if_absent` puts with
`ConditionExpression="attribute_not_exists(item_id)"` and treats `ConditionalCheckFailedException` as
`False`. A duplicate `item_id` is skipped, not overwritten, so re-posting never re-fires the Tier-1
consumer for an item already in flight. `202 {"written": 0}` therefore means "every id already
existed", not "nothing was accepted".

### What happens after a 202

The write lands in `recon-dev-items`, the platform's **only stream-enabled table**. The Tier-1 Lambda
consumes that stream (`LATEST`, batch 10, `bisect_batch_on_function_error`, 3 retries, SQS DLQ on
failure), auto-clears an unambiguous match against the mocked GL, and otherwise escalates by
opening a `PENDING` case for the Tier-2 map run to claim — the stream consumer dispatches nothing. See [case-lifecycle.md](case-lifecycle.md).

## `GET /skills`

Handler: `backend/skills_api/handler.py`, 15 s timeout, read-only. It checks `event["routeKey"] ==
"GET /skills"` (404 otherwise) and streams `s3://recon-dev-assets/skills-catalog.json` back verbatim.
Its IAM policy grants `s3:GetObject` on that single key.

The source of truth is the `SKILL.md` files bundled with the agent; the agent build publishes them as
JSON. There is no CRUD here and no DynamoDB — classification types are not stored in DynamoDB. The
console's Skills tab does **not** use this route; it reads and writes the live
`s3://<assets>/skills/<name>/SKILL.md` objects through its own BFF routes at `/api/recon/skills`.

## This API has no first-party caller

Worth knowing before you debug it, or decide it's broken:

- The console's "Create New" submission goes to its own BFF route `/api/recon/items`, which
  `lambda:Invoke`s `recon-dev-intake` **directly** with a synthetic `{"body": "..."}` envelope
  (`INTAKE_FUNCTION` env var, `RequestResponse` so intake's 400 + pydantic message reaches the toast).
  It bypasses API Gateway and the authorizer entirely, and caps a submission at 25 items — a cap that
  exists only in that route, not here.
- `NEXT_PUBLIC_RECON_API_BASE` is baked into the frontend image from `module.intake.api_endpoint`, but
  nothing in `chatbot-app/frontend/src` reads it.
- The endpoint is **not** a root Terraform output. Get it from the API:

  ```bash
  aws apigatewayv2 get-apis --profile <your-profile> \
    --query "Items[?Name=='recon-dev-api'].ApiEndpoint" --output text
  ```

  ```bash
  curl -sS -X POST "$API/items" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    --data @payload.json
  ```

So this API is the documented integration point for an upstream system, and today the console is not
that system.

## Operating notes

- **No CORS configuration.** The API declares no `cors_configuration`, so a browser on another origin
  cannot call it — there is no `OPTIONS` route and no `Access-Control-Allow-Origin`. Server-to-server
  only unless that changes.
- **Internet-facing regardless of `private_vpc`.** The flag moves the ALB and the Fargate task and
  leaves this endpoint exactly where it was — see
  [Reaching it from a private VPC deployment](#reaching-it-from-a-private-vpc-deployment) below.
- **No throttling is configured** — no stage `default_route_settings`, no per-route limits — so the
  account-level API Gateway default applies.
- **Access logs are the first place to look**, since a 401 leaves no Lambda trace. Each request logs
  `requestId`, `ip`, `requestTime`, `httpMethod`, `routeKey`, `status`, `protocol`, `responseLength`
  and `integrationError` to `/aws/apigateway/recon-dev-intake`.
- **`auto_deploy = true` on `$default`**, so a route or integration change is live as soon as the apply
  finishes; there is no separate deployment step to forget.

## Reaching it from a private VPC deployment

Nothing on this page changes when `private_vpc = true`, and that is the point worth stating loudly:
**this API stays internet-facing.** The flag makes the ALB internal, moves Fargate to the private
subnets, drops CloudFront and adds the interface endpoints — it does not touch `recon-dev-api`. In an
internet-restricted deployment the JWT authorizer is then the _only_ thing between the internet and
`POST /items`, which is a weaker position than everything else in that topology.

It is not an oversight in the module, and no variable can fix it: **an HTTP API cannot be made
private.** The `PRIVATE` endpoint type, resource policies and the `execute-api` interface endpoint are
all API Gateway **v1 (REST)** features. An HTTP API has no `endpoint_configuration`, accepts no
resource policy, and is not served by an `execute-api` VPCE — so pointing one at `recon-dev-api` and
expecting private ingress is the trap here. A private path is a different resource, not a setting.

So `private_vpc = true` builds a **second, private door onto the same Lambda**. It is implemented
(option 1 below). A lighter-weight alternative for in-account callers is described after it, and is
not deployed.

### The private door (deployed, `private_vpc = true` only)

`infra/modules/intake/private_api.tf`, gated on `private_api_enabled`, which
`infra/environments/recon/main.tf` wires from `private_vpc`. With the dev default (`false`) none of it
exists and the plan is unchanged.

```
caller (VPC / VPN / Direct Connect)
  → com.amazonaws.<region>.execute-api      interface endpoint (modules/network)
  → recon-dev-intake-private                PRIVATE REST API, resource policy: aws:SourceVpce == <vpce-id>
  → AWS_IAM (SigV4)                         no authorizer resource, no IdP in the path
  → recon-dev-intake                        the SAME Lambda — same 202/400, same idempotency
```

```
POST https://<api-id>-<vpce-id>.execute-api.<region>.vpce.amazonaws.com/v1/items
Authorization: AWS4-HMAC-SHA256 …          (SigV4, service name execute-api)
```

The URL is the `intake_private_api_url` root output (empty unless `private_vpc = true`). Stage `v1`;
`POST /items` is the only method.

| Resource                                     | Name / value                                      |
| -------------------------------------------- | ------------------------------------------------- |
| `aws_api_gateway_rest_api.private`           | `recon-dev-intake-private`, `types = ["PRIVATE"]` |
| `aws_api_gateway_method.post_items`          | `POST /items`, `authorization = "AWS_IAM"`        |
| `aws_api_gateway_integration.items`          | `AWS_PROXY` → `recon-dev-intake`                  |
| `aws_api_gateway_stage.v1`                   | stage `v1`, **no access logging** (see below)     |
| `aws_vpc_endpoint.interfaces["execute-api"]` | added to `_private_interface_endpoints`           |

Five things to know about it:

- **The request contract is unchanged** because the handler is unchanged. Validation, the
  all-or-nothing batch, the conditional put and the `written` count all come from the same code, so
  there is no second contract to keep in step — which is why the integration reuses the Lambda instead
  of a private twin of it.
- **SigV4, not a bearer token — a deliberate asymmetry with the public door.** A REST API's only native
  OIDC authorizer is `COGNITO_USER_POOLS`, and the console does run a user pool again under the default
  `auth_provider` — so that authorizer is available and is still the wrong choice here: it would bind
  this VPC-only door to whichever provider the *console* signs in through, so choosing `okta` or `entra`
  would silently take this API's authorization with it. The provider-agnostic alternative, a Lambda
  authorizer verifying the selected issuer's JWTs, would have to fetch that issuer's JWKS **from inside
  this VPC**, and a VPC-only endpoint whose authorization depends on internet egress fails closed the
  moment the NAT is removed — the one deployment this API exists for. It would also put PyJWT +
  `cryptography` into `modules/lambda-package`'s single shared `runtime_dependencies` list, which every
  backend Lambda's zip carries and which is duplicated in `.gitlab-ci.yml`. IAM avoids all of it,
  matches both AgentCore gateways, and is auditable per-principal in CloudTrail.
- **Callers need `execute-api:Invoke`** on the method, plus credentials — not a token, and not a pool,
  Okta or Entra user. Nothing in the repo calls it today.
- **No access logging, deliberately, and it costs you.** REST-API CloudWatch logging needs an IAM role
  ARN in API Gateway's **account** settings — a per-account singleton (`aws_api_gateway_account`) that
  silently overwrites whatever any other stack in the account set. So a request rejected by the
  resource policy or by IAM leaves **no trace anywhere**, because it never reaches the Lambda.
  `post_deploy_checklist` prints the three steps to turn it on.
- **The `execute-api` endpoint runs with private DNS OFF**, and that exception is load-bearing.
  Enabling it creates a private zone for the whole `*.execute-api.<region>.amazonaws.com` wildcard, so
  every in-VPC call to any public API Gateway API — `recon-dev-api` included — would resolve to the
  endpoint and fail there, since the service serves private REST APIs only. Hence the
  `<api-id>-<vpce-id>…vpce.amazonaws.com` hostname, which needs no private DNS. The comment on
  `private_dns_enabled` in `modules/network/main.tf` says so; don't tidy it back to a constant.

### The `lambda` endpoint is a latent no-NAT gap regardless

Worth flagging beyond intake, because it is the same failure class as the missing
`bedrock-agent-runtime` endpoint that [private-vpc-deployment.md](private-vpc-deployment.md) warns
about: **`lambda` is not in `_private_interface_endpoints`**, and four in-VPC callers invoke Lambdas.

| Caller                 | Invokes                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Frontend BFF (Fargate) | `recon-dev-intake` — the queue's "Create New" submission                                                            |
| Frontend BFF (Fargate) | the case-retry invoke (fire-and-forget)                                                                             |
| Tier-1 Lambda          | `GL_QUERY_FUNCTION` — the GL lookup (`backend/tier1/gl_match.py`)                                                   |
| Tier-1 Lambda          | the agent-worker retry from the console (`backend/tier1/invoke_agent.py`); the Tier-1 consumer no longer invokes it |

All four work today only because `private_vpc = true` leaves the NAT gateway in place. Removing the
NAT — the deliberate follow-up step in that page's "Enabling it" — takes manual submissions, the GL
lookup with it, and the symptom is a hang and a timeout rather than an
error naming the cause. The private REST API does not help here — it is an ingress path, and these are
outbound calls. Add the `lambda` endpoint in the same change that removes the NAT.

## IAM

Least privilege, and narrower than it looks in one place that matters.

| Role                   | Grants                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `recon-dev-intake`     | `dynamodb:PutItem` on the items table only — no read, no update, no delete |
| `recon-dev-skills-bff` | `s3:GetObject` on `<assets>/skills-catalog.json` only                      |
| both                   | ENI create/delete for the VPC attachment, and log-group writes             |

The ENI statement's resource is `arn:aws:ec2:<region>:<account>:*` on purpose. Narrowing it to
`network-interface/*` makes Lambda's `CreateFunction` pre-flight check fail with "The provided
execution role does not have permissions to call CreateNetworkInterface on EC2", because
`ec2:CreateNetworkInterface` is also evaluated against the subnet and security group ARNs. An existing
function is never re-validated, so the breakage surfaces only on a from-scratch create — easy to
introduce and not notice. The comment on it in both modules is load-bearing.
