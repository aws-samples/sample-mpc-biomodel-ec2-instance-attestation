import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Storage } from './storage';

export interface DeploymentProps {
  readonly asg: autoscaling.AutoScalingGroup;
  readonly amiIdParam: ssm.IStringParameter;
  readonly pcrValuesParam: ssm.IStringParameter;
  /** Bucket the build mirrors ami-id.txt + pcr_measurements.json into (under ami/). */
  readonly sourceBucket: s3.IBucket;
}

/**
 * Deployment stage for the attested-AMI rollout — Step Functions + Lambda.
 *
 * The reference architecture uses CodeDeploy + agent, which can't work on the
 * immutable attested AMI (no agent/SSH in PROD). New code ships as a *new AMI*,
 * so deploy = "AMI swap + ASG instance refresh".
 *
 * This was originally a CodeBuild bash script, but the poll/wait/parse control
 * flow was fragile (shell string parsing mangled the refresh status; the
 * bounded-loop-then-timeout structure mis-reported success). Step Functions is
 * the right tool for a poll-until-terminal-state wait, so the swap + refresh now
 * runs as a state machine using the classic job-poller pattern:
 *
 *   Submit (Lambda) -> Wait -> GetStatus (Lambda) -> Choice{Successful|Failed|loop}
 *
 * The Submit Lambda ALSO fixes the transient-SSM-parameter bug: after writing the
 * AMI id it reads the parameter back and confirms the value persisted (with
 * retries) BEFORE starting the instance refresh — so the ASG launch template
 * (which resolves the SSM param at launch) can never roll onto a stale AMI.
 *
 * Reads ami-id.txt / pcr_measurements.json from s3://<sourceBucket>/ami/ (the
 * build stage mirrors them there), so no pipeline-artifact unzip is needed.
 */
export class Deployment extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly submitFn: lambda.Function;
  public readonly statusFn: lambda.Function;

  constructor(scope: Construct, id: string, props: DeploymentProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // ==================== Submit Lambda ====================
    // Reads ami-id/pcr from S3, writes SSM (confirmed), starts the instance refresh.
    this.submitFn = new lambda.Function(this, 'SubmitFn', {
      functionName: 'boltz-attestation-deploy-submit',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      environment: {
        SOURCE_BUCKET: props.sourceBucket.bucketName,
        AMI_ID_PARAM: Storage.AMI_ID_PARAM_NAME,
        PCR_VALUES_PARAM: Storage.PCR_VALUES_PARAM_NAME,
        ASG_NAME: props.asg.autoScalingGroupName,
      },
      code: lambda.Code.fromInline(SUBMIT_CODE),
    });
    props.sourceBucket.grantRead(this.submitFn, 'ami/*');
    props.amiIdParam.grantWrite(this.submitFn);
    props.amiIdParam.grantRead(this.submitFn);
    props.pcrValuesParam.grantWrite(this.submitFn);
    // CRITICAL: putParameter with DataType=aws:ec2:image makes SSM asynchronously
    // validate the AMI via ec2:DescribeImages USING THE CALLER'S credentials. Without
    // this permission, SSM silently rejects the new value (put returns 200 but the
    // version never commits, and read-back keeps returning the old value) — which is
    // exactly the "did not converge" failure. DescribeImages has no resource scoping.
    this.submitFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeImages'],
      resources: ['*'],
    }));
    this.submitFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['autoscaling:StartInstanceRefresh', 'autoscaling:DescribeAutoScalingGroups'],
      resources: ['*'],
    }));

    // ==================== Status Lambda (poller) ====================
    this.statusFn = new lambda.Function(this, 'StatusFn', {
      functionName: 'boltz-attestation-deploy-status',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(STATUS_CODE),
    });
    this.statusFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['autoscaling:DescribeInstanceRefreshes'],
      resources: ['*'],
    }));

    // ==================== State machine (job-poller) ====================
    const submit = new tasks.LambdaInvoke(this, 'SubmitDeploy', {
      lambdaFunction: this.submitFn,
      payloadResponseOnly: true, // returns {refreshId, asgName, amiId}
      resultPath: '$.deploy',
    });

    const wait = new sfn.Wait(this, 'WaitForRefresh', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const getStatus = new tasks.LambdaInvoke(this, 'GetRefreshStatus', {
      lambdaFunction: this.statusFn,
      payloadResponseOnly: true, // returns {status}
      payload: sfn.TaskInput.fromObject({
        asgName: sfn.JsonPath.stringAt('$.deploy.asgName'),
        refreshId: sfn.JsonPath.stringAt('$.deploy.refreshId'),
      }),
      resultPath: '$.refresh',
    });

    const succeeded = new sfn.Succeed(this, 'DeploySucceeded');
    const failed = new sfn.Fail(this, 'DeployFailed', {
      causePath: sfn.JsonPath.stringAt('$.refresh.status'),
      error: 'InstanceRefreshFailed',
    });

    const choice = new sfn.Choice(this, 'RefreshDone?')
      .when(sfn.Condition.stringEquals('$.refresh.status', 'Successful'), succeeded)
      .when(sfn.Condition.stringEquals('$.refresh.status', 'Failed'), failed)
      .when(sfn.Condition.stringEquals('$.refresh.status', 'Cancelled'), failed)
      .otherwise(wait);

    const definition = submit.next(wait).next(getStatus).next(choice);

    this.stateMachine = new sfn.StateMachine(this, 'DeployStateMachine', {
      stateMachineName: 'boltz-attestation-deploy',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      // Overall ceiling well above the ~10-min InstanceWarmup for a 1-instance ASG.
      timeout: cdk.Duration.minutes(60),
      comment: 'Attested AMI swap: put SSM (confirmed) + ASG instance refresh (poll to terminal)',
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SF1',
      reason: 'Step Function CloudWatch logging out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SF2',
      reason: 'Step Function X-Ray tracing out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Lambdas pinned to a stable, supported Python runtime (3.13)',
    });
    const submitLogicalId = cdk.Stack.of(this).getLogicalId(this.submitFn.node.defaultChild as cdk.CfnResource);
    const statusLogicalId = cdk.Stack.of(this).getLogicalId(this.statusFn.node.defaultChild as cdk.CfnResource);
    const sourceBucketLogicalId = cdk.Stack.of(this).getLogicalId(props.sourceBucket.node.defaultChild as cdk.CfnResource);
    const nagRules: Record<string, string> = {};
    nagRules['AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]'] =
      'Lambda basic execution role is the AWS managed policy for CloudWatch Logs';
    nagRules['AwsSolutions-IAM5[Resource::*]'] =
      'autoscaling StartInstanceRefresh/DescribeInstanceRefreshes/DescribeAutoScalingGroups require Resource::* (no resource-level scoping)';
    nagRules[`AwsSolutions-IAM5[Resource::<${submitLogicalId}.Arn>:*]`] =
      'Step Functions grantInvoke targets the submit Lambda and its version alias';
    nagRules[`AwsSolutions-IAM5[Resource::<${statusLogicalId}.Arn>:*]`] =
      'Step Functions grantInvoke targets the status Lambda and its version alias';
    nagRules[`AwsSolutions-IAM5[Resource::<${sourceBucketLogicalId}.Arn>/ami/*]`] =
      'Submit Lambda reads only the ami/* prefix of the source bucket';
    for (const a of ['s3:GetObject*', 's3:GetBucket*', 's3:List*']) {
      nagRules[`AwsSolutions-IAM5[Action::${a}]`] = 'Submit Lambda reads ami/* from the source bucket';
    }
    void region;
    void account;
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}

// Submit: read ami-id/pcr from S3 -> put SSM (confirm read-back) -> start refresh.
// This literal holds Python source for an inline Lambda; `{...}` are Python f-string
// fields, not JS template placeholders, so there is intentionally no `${}` here.
// nosemgrep: missing-template-string-indicator
const SUBMIT_CODE = `
import os, json, time
import boto3

s3 = boto3.client("s3")
ssm = boto3.client("ssm")
asg = boto3.client("autoscaling")

BUCKET = os.environ["SOURCE_BUCKET"]
AMI_ID_PARAM = os.environ["AMI_ID_PARAM"]
PCR_VALUES_PARAM = os.environ["PCR_VALUES_PARAM"]
ASG_NAME = os.environ["ASG_NAME"]

def _get(key):
    return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read().decode("utf-8").strip()

def handler(event, context):
    ami_id = _get("ami/ami-id.txt")
    if not ami_id.startswith("ami-"):
        raise Exception(f"Invalid ami-id from S3: {ami_id!r}")
    print(f"Deploying AMI {ami_id} to ASG {ASG_NAME}")

    # 1. Write the AMI id (aws:ec2:image datatype so the launch template accepts it).
    ssm.put_parameter(Name=AMI_ID_PARAM, Value=ami_id, Type="String",
                      DataType="aws:ec2:image", Overwrite=True)

    # 2. PCR trust store (best-effort; may be absent).
    try:
        pcr = _get("ami/pcr_measurements.json")
        ssm.put_parameter(Name=PCR_VALUES_PARAM, Value=pcr, Type="String", Overwrite=True)
    except s3.exceptions.NoSuchKey:
        print("No pcr_measurements.json in S3; skipping PCR update")

    # 3. CONFIRM the write persisted before rolling (fixes the transient-SSM bug):
    #    the ASG launch template resolves this param at launch, so we must not start
    #    the refresh until SSM definitively returns the new value.
    for attempt in range(10):
        cur = ssm.get_parameter(Name=AMI_ID_PARAM)["Parameter"]["Value"]
        if cur == ami_id:
            print(f"SSM confirmed {AMI_ID_PARAM}={ami_id} after {attempt+1} read(s)")
            break
        print(f"SSM not yet consistent (got {cur}); retrying")
        time.sleep(3)
    else:
        raise Exception(f"SSM {AMI_ID_PARAM} did not converge to {ami_id}")

    # 4. Start the instance refresh.
    resp = asg.start_instance_refresh(
        AutoScalingGroupName=ASG_NAME,
        Preferences={"MinHealthyPercentage": 0, "InstanceWarmup": 300},
    )
    refresh_id = resp["InstanceRefreshId"]
    print(f"Started instance refresh {refresh_id}")
    return {"refreshId": refresh_id, "asgName": ASG_NAME, "amiId": ami_id}
`;

// Status: return the current instance-refresh status string.
// Python source for an inline Lambda; `{...}` are Python f-string fields, not JS
// template placeholders, so there is intentionally no `${}` here.
// nosemgrep: missing-template-string-indicator
const STATUS_CODE = `
import boto3
asg = boto3.client("autoscaling")

def handler(event, context):
    r = asg.describe_instance_refreshes(
        AutoScalingGroupName=event["asgName"],
        InstanceRefreshIds=[event["refreshId"]],
    )
    refreshes = r.get("InstanceRefreshes", [])
    status = refreshes[0]["Status"] if refreshes else "Unknown"
    pct = refreshes[0].get("PercentagesComplete") if refreshes else None
    print(f"Instance refresh {event['refreshId']} status={status} pct={pct}")
    return {"status": status}
`;
