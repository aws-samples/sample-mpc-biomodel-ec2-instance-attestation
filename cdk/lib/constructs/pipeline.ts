import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

// Exact granular cdk-nag key for the SFN invoke action's execution-ARN wildcard on
// the pipeline role (captured from `cdk synth` output — the resource renders as a
// Fn::Select/Split token over the deploy state machine ARN).
const SFN_EXEC_NAG_KEY =
  'AwsSolutions-IAM5[Resource::arn:{"Fn::Select":[1,{"Fn::Split":[":",{"Ref":"DeploymentDeployStateMachineFEC8C257"}]}]}:states:{"Fn::Select":[3,{"Fn::Split":[":",{"Ref":"DeploymentDeployStateMachineFEC8C257"}]}]}:{"Fn::Select":[4,{"Fn::Split":[":",{"Ref":"DeploymentDeployStateMachineFEC8C257"}]}]}:execution:{"Fn::Select":[6,{"Fn::Split":[":",{"Ref":"DeploymentDeployStateMachineFEC8C257"}]}]}:*]';

export interface PipelineProps {
  readonly sourceBucket: s3.Bucket;
  /** CodeBuild project that builds + registers the attested AMI. */
  readonly buildProject: codebuild.Project;
  /** State machine that swaps the ASG to the new AMI and polls the instance refresh. */
  readonly deployStateMachine: sfn.IStateMachine;
}

/**
 * CodePipeline: Source (S3) -> Build (kiwi-ng AMI) -> Deploy (AMI swap + refresh).
 *
 * Triggered by uploading source/source.zip to the artifacts bucket (see
 * scripts/package-and-upload.sh). The build stage produces ami-id.txt +
 * pcr_measurements.json; the deploy stage updates the SSM AMI parameter and
 * starts an ASG instance refresh so new attested instances launch.
 */
export class DeploymentPipeline extends Construct {
  public readonly pipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // Own the artifact bucket explicitly so teardown is complete. The Pipeline construct
    // otherwise auto-creates one with a RETAIN policy, which survives `cdk destroy` and
    // leaves an orphaned boltzattestationstack-pipelineartifactsbucket* bucket behind on
    // every stack lifecycle. DESTROY + autoDeleteObjects makes a plain stack delete empty
    // and remove it, so no manual cleanup (or cleanup.sh sweep) is needed.
    const artifactBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'boltz-attestation-pipeline',
      pipelineType: codepipeline.PipelineType.V2,
      restartExecutionOnUpdate: false,
      artifactBucket,
    });

    // Source Stage - S3 (trigger via custom EventBridge rule below)
    this.pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.S3SourceAction({
          actionName: 'S3Source',
          bucket: props.sourceBucket,
          bucketKey: 'source/source.zip',
          output: sourceOutput,
          trigger: codepipeline_actions.S3Trigger.NONE,
        }),
      ],
    });

    // EventBridge rule on native S3 notifications (requires eventBridgeEnabled bucket)
    new events.Rule(this, 'S3SourceTriggerRule', {
      ruleName: 'boltz-attestation-s3-source-trigger',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.sourceBucket.bucketName] },
          object: { key: [{ prefix: 'source/source.zip' }] },
        },
      },
      targets: [new targets.CodePipeline(this.pipeline)],
    });

    // Build Stage - kiwi-ng AMI build + register
    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'BuildAmi',
          project: props.buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // Deploy Stage - AMI swap + ASG instance refresh via Step Functions.
    // The state machine reads ami-id/pcr from s3://<sourceBucket>/ami/ (mirrored by
    // the build stage), so it needs no artifact input. CodePipeline's SFN invoke
    // action waits for the STANDARD execution to reach a terminal state, so a failed
    // refresh (or a non-converged SSM write) fails the stage.
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.StepFunctionInvokeAction({
          actionName: 'SwapAmiAndRefresh',
          stateMachine: props.deployStateMachine,
        }),
      ],
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-KMS5',
      reason: 'KMS key rotation out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Bucket logging out of scope for sample app',
    });

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const artifactsBucketNode = this.pipeline.artifactBucket.node.defaultChild as cdk.CfnResource;
    const sourceBucketNode = props.sourceBucket.node.defaultChild as cdk.CfnResource;
    const artifactsBucketLogicalId = cdk.Stack.of(this).getLogicalId(artifactsBucketNode);
    const sourceBucketLogicalId = cdk.Stack.of(this).getLogicalId(sourceBucketNode);

    // The pipeline artifact bucket is DESTROY + autoDeleteObjects so teardown is complete;
    // S3 server access logging is out of scope for this sample (same as the other buckets).
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Pipeline artifact bucket: S3 access logging out of scope for sample app',
    });

    const nagRules: Record<string, string> = {};
    const pipelineReason =
      'CDK Pipeline L2 construct internally generates grant*() with wildcard actions; cannot scope further without rewriting L2';
    for (const appliesTo of [
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Action::kms:GenerateDataKey*',
      'Action::kms:ReEncrypt*',
      `Resource::<${artifactsBucketLogicalId}.Arn>/*`,
      `Resource::<${sourceBucketLogicalId}.Arn>/*`,
    ]) {
      nagRules[`AwsSolutions-IAM5[${appliesTo}]`] = pipelineReason;
    }
    // SFN invoke action grants the pipeline role StartExecution/DescribeExecution on
    // the deploy state machine executions; the execution ARN renders as a complex
    // Fn::Select/Split token (filled in from the synth finding below).
    nagRules[SFN_EXEC_NAG_KEY] = pipelineReason;
    void region;
    void account;
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}
