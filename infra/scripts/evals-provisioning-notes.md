# Online-evaluation provisioning notes

Reference notes for `infra/modules/agent-evals`. Re-derive any of them with
`python infra/scripts/verify_harness_surface.py` (read-only) plus the AWS calls quoted below.

## Provider coverage

Provider **`hashicorp/aws ~> 6.51`** (the repo's pin) carries both resources the module needs:

- `aws_bedrockagentcore_evaluator` ✅
- `aws_bedrockagentcore_online_evaluation_config` ✅

So evaluations are provisioned with native Terraform resources — no boto3 `terraform_data` fallback,
and nothing about an apply depends on the local AWS-CLI version.

`aws_bedrockagentcore_harness` and `aws_bedrockagentcore_gateway_target` are present too. The harness
is nonetheless an `AWS::BedrockAgentCore::Harness` inside an `aws_cloudformation_stack`
(`infra/modules/recon-agent-harness`).

## SDK shapes (botocore 1.43.48)

**CreateEvaluator**: `evaluatorName, evaluatorConfig, level, description, kmsKeyArn, tags, clientToken`
**CreateOnlineEvaluationConfig**: `onlineEvaluationConfigName, description, rule, dataSourceConfig, evaluators, insights, clusteringConfig, evaluationExecutionRoleArn, enableOnCreate, tags, clientToken`

## Which log groups the data source has to name

Harness OTel traces land in the account-level `aws/spans` log group, so
`dataSourceConfig.cloudWatchLogs.logGroupNames` has to include it. It is not sufficient on its own:
an evaluator only sees an event record that is IN a configured group, so the backend's own event-record
group belongs in the list beside it (`log_group_names` in `infra/modules/agent-evals/main.tf`).

## Transaction Search

Online evaluations cannot consume traces without it. Check with:

```bash
aws xray get-trace-segment-destination --profile <your-profile> --region us-east-1
```

Anything other than `CloudWatchLogs` means the account-level Transaction Search enablement is
outstanding — a one-time console step, documented in the root README.
