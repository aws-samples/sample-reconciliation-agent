# Evals Spike Findings (2026-07-23)

## Provider feasibility

Provider **`hashicorp/aws ~> 6.51`** (the repo's existing pin) includes:

- `aws_bedrockagentcore_evaluator` ✅
- `aws_bedrockagentcore_online_evaluation_config` ✅

→ **Use native TF resources.** No boto3 `terraform_data` fallback needed.

Also present (future simplification): `aws_bedrockagentcore_harness`, `aws_bedrockagentcore_gateway_target`.

## SDK shapes (botocore 1.43.48)

**CreateEvaluator**: `evaluatorName, evaluatorConfig, level, description, kmsKeyArn, tags, clientToken`
**CreateOnlineEvaluationConfig**: `onlineEvaluationConfigName, description, rule, dataSourceConfig, evaluators, insights, clusteringConfig, evaluationExecutionRoleArn, enableOnCreate, tags, clientToken`

## Harness log group

From the live harness session (`recon_dev_harness-EJrS0PkWnx`): the OTel traces go to the account-level `aws/spans` log group. The online eval config's `dataSourceConfig.cloudWatchLogs.logGroupNames` should include `aws/spans` and/or a harness-specific log group whose name we'll verify from the first harness session's CloudWatch output.

## Transaction Search

Required for online evaluations consuming harness traces. Check with:

```bash
aws xray get-trace-segment-destination --profile huthmac --region us-east-1
```

If not `CloudWatchLogs`, the account-level Transaction Search enablement is pending (one-time console step, documented in README).
