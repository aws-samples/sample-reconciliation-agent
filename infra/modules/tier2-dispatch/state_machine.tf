# ---------------------------------------------------------------------------------
# The map run
# ---------------------------------------------------------------------------------
# Collect PENDING cases, then investigate them MaxConcurrency at a time. Children never fail: every
# error path is caught and recorded on the case, which is why no ToleratedFailure* is set -- there is
# nothing for a failure threshold to count.

resource "aws_iam_role" "states" {
  name = "${var.name_prefix}-tier2-states"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "states" {
  name = "${var.name_prefix}-tier2-states-policy"
  role = aws_iam_role.states.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.collect.arn,
          aws_lambda_function.dispatch.arn,
          aws_lambda_function.case_step.arn,
          var.agent_worker_function_arn,
        ]
      },
      {
        # A Distributed Map runs each iteration as a CHILD EXECUTION of this same state machine, so it
        # needs to start and observe itself. Without this the Map Run fails immediately with an
        # authorization error that names StartExecution rather than the Map.
        Effect = "Allow"
        Action = [
          "states:StartExecution",
          "states:DescribeExecution",
          "states:StopExecution",
        ]
        Resource = [
          "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name_prefix}-tier2",
          "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:execution:${var.name_prefix}-tier2*",
        ]
      },
      {
        # The Map's ItemReader reads the collected list itself, under the STATES role -- not the
        # collector's. Granting it only to the Lambda role is a plausible and silent mistake.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.runs_bucket_arn}/${var.runs_prefix}*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "states" {
  name              = "/aws/vendedlogs/states/${var.name_prefix}-tier2"
  retention_in_days = 365
}

locals {
  # The child that investigates ONE item. Standard, not Express: Express does not support
  # waitForTaskToken at all, which is the entire mechanism here.
  _investigate_child = {
    StartAt = "ClaimCase"
    States = {
      # PENDING -> IN_PROGRESS. A lost race returns claimed:false rather than failing, which is what
      # makes re-running a map over the same list free.
      ClaimCase = {
        Type     = "Task"
        Resource = aws_lambda_function.case_step.arn
        Parameters = {
          action      = "claim"
          "item_id.$" = "$.item_id"
        }
        ResultPath = "$.claim"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
          IntervalSeconds = 2
          MaxAttempts     = 4
          BackoffRate     = 2
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarkFailed" }]
        Next  = "AlreadyClaimed"
      }

      AlreadyClaimed = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.claim.claimed"
          BooleanEquals = false
          Next          = "Skipped"
        }]
        Default = "ChooseBackend"
      }

      Skipped = { Type = "Succeed" }

      # The backend was resolved ONCE by collect and stamped on every item, so a run cannot straddle an
      # operator's mid-run switch.
      ChooseBackend = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.backend"
          StringEquals = "harness"
          Next         = "InvokeHarnessWorker"
        }]
        Default = "DispatchRuntime"
      }

      # The async path. The dispatcher returns in ~1s; the execution then PAUSES here, billing no
      # compute, until the agent calls SendTaskSuccess with this token.
      DispatchRuntime = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        Parameters = {
          FunctionName = aws_lambda_function.dispatch.arn
          Payload = {
            "taskToken.$"  = "$$.Task.Token"
            "item.$"       = "$.item"
            "item_id.$"    = "$.item_id"
            "session_id.$" = "$.session_id"
            agent_arn      = var.agent_runtime_arn
          }
        }
        TimeoutSeconds = var.state_timeout_seconds
        Retry = [{
          # Only transport-level failures. A dispatch that DID land must never be retried -- the agent
          # would be asked to investigate the same item twice against one session.
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException", "ThrottlingException"]
          IntervalSeconds = 2
          MaxAttempts     = 4
          BackoffRate     = 2
          MaxDelaySeconds = 60
          # Every child otherwise backs off on an identical schedule and re-collides on the same quota.
          JitterStrategy = "FULL"
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarkFailed" }]
        Next  = "Done"
      }

      # The harness backend runs in-process inside the blocking worker, so there is no container to
      # background into and no token to wait on. It stays synchronous and stays bounded by the worker's
      # reserved concurrency instead of by MaxConcurrency.
      InvokeHarnessWorker = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = var.agent_worker_function_arn
          Payload = {
            "item.$"       = "$.item"
            "session_id.$" = "$.session_id"
            agent_arn      = var.agent_runtime_arn
          }
        }
        TimeoutSeconds = var.state_timeout_seconds
        Catch          = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarkFailed" }]
        Next           = "Done"
      }

      # The backstop for the failure the agent cannot report itself: if the container died outright,
      # nothing in it ran to call SendTaskFailure or to write the case row.
      MarkFailed = {
        Type     = "Task"
        Resource = aws_lambda_function.case_step.arn
        Parameters = {
          action      = "fail"
          "item_id.$" = "$.item_id"
          "reason.$"  = "States.Format('{}', $.error)"
        }
        ResultPath = "$.failure"
        # Swallowed on purpose: a child that cannot record its failure must still not fail the Map Run.
        # The error is already in this execution's history either way.
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "Done" }]
        Next  = "Done"
      }

      Done = { Type = "Succeed" }
    }
  }

  tier2_definition = jsonencode({
    Comment = "Tier-2 investigations, bounded by MaxConcurrency and dispatched by task token."
    StartAt = "Collect"
    States = {
      Collect = {
        Type     = "Task"
        Resource = aws_lambda_function.collect.arn
        Parameters = {
          "execution_name.$" = "$$.Execution.Name"
        }
        ResultPath = "$.run"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
          IntervalSeconds = 2
          MaxAttempts     = 4
          BackoffRate     = 2
        }]
        Next = "AnythingToDo"
      }

      AnythingToDo = {
        Type = "Choice"
        Choices = [{
          Variable           = "$.run.count"
          NumericGreaterThan = 0
          Next               = "Investigate"
        }]
        Default = "NothingToDo"
      }

      NothingToDo = { Type = "Succeed" }

      Investigate = {
        Type = "Map"
        # ⚠️ THE concurrency bound for the runtime backend. A child paused on waitForTaskToken is still
        # a RUNNING child execution, so this counts investigations in flight rather than calls being
        # made -- which is why the bound can live here instead of on Lambda concurrency.
        MaxConcurrency = var.max_concurrent_investigations
        ItemProcessor = merge(local._investigate_child, {
          ProcessorConfig = {
            Mode          = "DISTRIBUTED"
            ExecutionType = "STANDARD"
          }
        })
        # ItemReader reads S3 only -- there is no DynamoDB source, which is why collect exists.
        ItemReader = {
          Resource = "arn:aws:states:::s3:getObject"
          ReaderConfig = {
            InputType = "JSON"
          }
          Parameters = {
            "Bucket.$" = "$.run.bucket"
            "Key.$"    = "$.run.key"
          }
        }
        # Each item from S3 already carries {item_id, domain, session_id}; the child adds only the
        # run-wide backend. The session id is deliberately NOT built here: AgentCore requires
        # [a-zA-Z0-9][a-zA-Z0-9-_]* and >=33 characters, and real item ids carry dots and '#', so
        # States.Format would emit ids the runtime rejects. `collect` derives it with the same
        # function the blocking worker uses (recon_core.session).
        ItemSelector = {
          "item_id.$"    = "$$.Map.Item.Value.item_id"
          "item.$"       = "$$.Map.Item.Value"
          "backend.$"    = "$.run.backend"
          "session_id.$" = "$$.Map.Item.Value.session_id"
        }
        # No ToleratedFailure*: children never fail (every path Catches to MarkFailed then Succeeds), so
        # a failure threshold would have nothing to count. Failures are recorded on the case row.
        ResultPath = null
        Next       = "Finished"
      }

      Finished = { Type = "Succeed" }
    }
  })
}

resource "aws_sfn_state_machine" "tier2" {
  name     = "${var.name_prefix}-tier2"
  role_arn = aws_iam_role.states.arn
  type     = "STANDARD"

  definition = local.tier2_definition

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.states.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tracing_configuration {
    enabled = true
  }

  depends_on = [aws_iam_role_policy.states]
}

# ---------------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------------
# Ships DISABLED. Merging this must not start firing agent runs -- and therefore spending on Bedrock --
# in an environment nobody is watching. Opt in per environment via schedule_enabled.

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = "${var.name_prefix}-tier2-schedule"
  description         = "Start a Tier-2 map run over PENDING cases."
  schedule_expression = var.schedule_expression
  state               = var.schedule_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_iam_role" "events" {
  name = "${var.name_prefix}-tier2-events"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "events.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "events" {
  name = "${var.name_prefix}-tier2-events-policy"
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = aws_sfn_state_machine.tier2.arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "schedule" {
  rule     = aws_cloudwatch_event_rule.schedule.name
  arn      = aws_sfn_state_machine.tier2.arn
  role_arn = aws_iam_role.events.arn
  input    = jsonencode({})
}
