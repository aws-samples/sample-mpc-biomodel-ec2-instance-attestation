import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface StorageProps {
  readonly accountId: string;
  readonly region: string;
}

/**
 * Storage + configuration parameters for the AMI build/deploy pipeline.
 *
 * Unlike a container pipeline, the immutable build artifact here is a
 * NitroTPM-attested AMI (built by kiwi-ng). We therefore keep:
 *  - an S3 bucket that holds the packaged build source (source/source.zip)
 *    that triggers the pipeline, plus the raw image + PCR measurements the
 *    CodeBuild AMI builder uploads;
 *  - an SSM parameter that always points at the latest registered AMI id. The
 *    ASG launch template resolves this parameter, so an "AMI swap" is just an
 *    SSM update followed by an ASG instance refresh.
 */
export class Storage extends Construct {
  public readonly sourceBucket: s3.Bucket;
  // Imported references (the actual parameters are create-only seeded via a custom
  // resource below, so CloudFormation never overwrites the pipeline-written value).
  public readonly amiIdParam: ssm.IStringParameter;
  public readonly pcrValuesParam: ssm.IStringParameter;
  /**
   * Build-time profile the CodeBuild AMI builder reads at build start: 'prod'
   * (attested Zero Operator Access) or 'foa' (Full Operator Access, dev/test).
   * Seeded to 'prod' on first create and NEVER clobbered by a later cdk deploy
   * (create-only seed), so an operator can switch the next build's profile with
   * `aws ssm put-parameter --name /boltz-attestation/build-profile --value foa
   * --overwrite` (no code change, no stack redeploy).
   */
  public readonly buildProfileParam: ssm.IStringParameter;
  // The seed custom resources (real CFN resources). Consumers that resolve the params
  // at resource-creation time (e.g. the launch template's resolve:ssm AMI) must depend
  // on these so the parameter exists (with its aws:ec2:image datatype) first.
  public readonly seedAmiParam: Construct;
  public readonly seedPcrParam: Construct;

  /** SSM parameter name that stores the current AMI id. */
  public static readonly AMI_ID_PARAM_NAME = '/boltz-attestation/ami-id';
  /** SSM parameter name that stores the current PCR measurements JSON. */
  public static readonly PCR_VALUES_PARAM_NAME = '/boltz-attestation/pcr-values/prod';
  /** SSM parameter name that stores the kiwi build profile ('prod' | 'foa'). */
  public static readonly BUILD_PROFILE_PARAM_NAME = '/boltz-attestation/build-profile';

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    // ==================== S3 Bucket for build source + AMI artifacts ====================
    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: `boltz-attestation-ami-${props.accountId}-${props.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      enforceSSL: true,
      // Enable EventBridge notifications so S3 events trigger CodePipeline
      eventBridgeEnabled: true,
    });

    // ==================== SSM Parameters (create-only seed) ====================
    // The AMI id is consumed by the ASG launch template via
    // resolveSsmParameterAtLaunch, which requires the parameter to have datatype
    // `aws:ec2:image` (validates the value is a real AMI). It must be seeded with a
    // valid AMI so the very first deploy can launch instances.
    //
    // CRITICAL OWNERSHIP RULE: after the first pipeline run, the *pipeline* owns
    // this parameter's value (it writes the attested kiwi-ng AMI id). If we managed
    // the parameter as a CloudFormation `AWS::SSM::Parameter`, every `cdk deploy`
    // would reset the value back to the AL2023 seed and clobber the attested AMI
    // (exactly the bug we hit). So we seed it with a custom resource that only
    // writes on CREATE — never on stack UPDATE — leaving the pipeline as sole owner.
    const seedAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64'
    );

    const amiParamArn = `arn:aws:ssm:${props.region}:${props.accountId}:parameter${Storage.AMI_ID_PARAM_NAME}`;
    // Seed the AMI param exactly ONCE, on first create, and NEVER touch it again.
    // The pipeline's deploy stage is the runtime owner of this value; a `cdk deploy`
    // must not clobber or churn it. AwsCustomResource falls back to `onCreate` for
    // stack UPDATEs when no `onUpdate` is given — which re-ran putParameter on every
    // deploy and raced the pipeline's writes. So we give an explicit no-op `onUpdate`
    // (a describe, not a put) and a stable physicalResourceId so CFN never deletes +
    // recreates the param on update either.
    const seedAmi = new AwsCustomResource(this, 'SeedAmiIdParam', {
      resourceType: 'Custom::SeedSsmAmiParam',
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: Storage.AMI_ID_PARAM_NAME,
          Value: seedAmiId,
          Type: 'String',
          DataType: 'aws:ec2:image',
          Overwrite: false,
        },
        physicalResourceId: PhysicalResourceId.of(Storage.AMI_ID_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterAlreadyExists',
      },
      // Explicit no-op on UPDATE: read the param, never write it. Keeps the same
      // physicalResourceId so no delete/recreate, and leaves the pipeline's value intact.
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: { Name: Storage.AMI_ID_PARAM_NAME },
        physicalResourceId: PhysicalResourceId.of(Storage.AMI_ID_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      // Delete the parameter on stack destroy so teardown is clean (no orphaned SSM
      // params). The physicalResourceId is stable (the param name), so onDelete only
      // fires on an actual resource delete (stack destroy), not on in-place updates —
      // so this does not wipe the pipeline-written value during a normal cdk deploy.
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: { Name: Storage.AMI_ID_PARAM_NAME },
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
          resources: [amiParamArn],
        }),
        // CRITICAL: putParameter with DataType=aws:ec2:image makes SSM
        // asynchronously validate the AMI via ec2:DescribeImages USING THE SEED
        // ROLE'S credentials. Without this permission the put returns 200 (Version 1)
        // but SSM silently drops the value moments later (no DeleteParameter event) —
        // so the launch template's resolve:ssm alias then fails with "The following
        // aliases are invalid: /boltz-attestation/ami-id". DescribeImages has no
        // resource-level scoping. (The deploy Submit Lambda needs this for the same
        // reason — see constructs/codedeploy.ts.)
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeImages'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // Reference the seeded parameter for grantRead/grantWrite by consumers. Import by
    // ARN (NOT fromStringParameterName): the latter emits a CloudFormation
    // AWS::SSM::Parameter::Value<String> template parameter that CloudFormation resolves
    // at CHANGESET creation — before the seed custom resource has created the param — so
    // the very first (clean-slate) deploy fails with "Unable to fetch parameters". ARN
    // import only needs the name/ARN for grants, no pre-deploy value fetch.
    this.amiIdParam = ssm.StringParameter.fromStringParameterAttributes(
      this,
      'AmiIdParamRef',
      { parameterName: Storage.AMI_ID_PARAM_NAME, forceDynamicReference: true }
    );
    // Ensure the parameter exists before anything reads it.
    this.amiIdParam.node.addDependency(seedAmi);
    this.seedAmiParam = seedAmi;

    // PCR measurements (attestation trust store). Same create-only ownership model:
    // the pipeline overwrites it with real PCR4/PCR7 after each build.
    const pcrParamArn = `arn:aws:ssm:${props.region}:${props.accountId}:parameter${Storage.PCR_VALUES_PARAM_NAME}`;
    const seedPcr = new AwsCustomResource(this, 'SeedPcrParam', {
      resourceType: 'Custom::SeedSsmPcrParam',
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: Storage.PCR_VALUES_PARAM_NAME,
          Value: '{}',
          Type: 'String',
          Overwrite: false,
        },
        physicalResourceId: PhysicalResourceId.of(Storage.PCR_VALUES_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterAlreadyExists',
      },
      // No-op on UPDATE (read, never write); delete on stack destroy for clean teardown.
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: { Name: Storage.PCR_VALUES_PARAM_NAME },
        physicalResourceId: PhysicalResourceId.of(Storage.PCR_VALUES_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: { Name: Storage.PCR_VALUES_PARAM_NAME },
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
          resources: [pcrParamArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    // forceDynamicReference (see AmiIdParamRef note) to avoid a pre-deploy SSM value fetch.
    this.pcrValuesParam = ssm.StringParameter.fromStringParameterAttributes(
      this,
      'PcrValuesParamRef',
      { parameterName: Storage.PCR_VALUES_PARAM_NAME, forceDynamicReference: true }
    );
    this.pcrValuesParam.node.addDependency(seedPcr);
    this.seedPcrParam = seedPcr;

    // Build profile ('prod' | 'foa'). Create-only seed = 'prod' (ZOA is the secure
    // default). Same ownership model as the AMI/PCR params: cdk deploy never clobbers
    // the value, so an operator can `aws ssm put-parameter ... --value foa --overwrite`
    // to build the FOA (dev/test) AMI on the next pipeline run, and it persists across
    // redeploys until they set it back. The CodeBuild project reads it at build start
    // via a PARAMETER_STORE environment variable (see constructs/codebuild.ts).
    const buildProfileParamArn = `arn:aws:ssm:${props.region}:${props.accountId}:parameter${Storage.BUILD_PROFILE_PARAM_NAME}`;
    const seedBuildProfile = new AwsCustomResource(this, 'SeedBuildProfileParam', {
      resourceType: 'Custom::SeedSsmBuildProfileParam',
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: Storage.BUILD_PROFILE_PARAM_NAME,
          Value: 'prod',
          Type: 'String',
          Overwrite: false,
        },
        physicalResourceId: PhysicalResourceId.of(Storage.BUILD_PROFILE_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterAlreadyExists',
      },
      // No-op on UPDATE (read, never write); delete on stack destroy for clean teardown.
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: { Name: Storage.BUILD_PROFILE_PARAM_NAME },
        physicalResourceId: PhysicalResourceId.of(Storage.BUILD_PROFILE_PARAM_NAME),
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: { Name: Storage.BUILD_PROFILE_PARAM_NAME },
        ignoreErrorCodesMatching: 'ParameterNotFound',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
          resources: [buildProfileParamArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    this.buildProfileParam = ssm.StringParameter.fromStringParameterAttributes(
      this,
      'BuildProfileParamRef',
      { parameterName: Storage.BUILD_PROFILE_PARAM_NAME, forceDynamicReference: true }
    );
    this.buildProfileParam.node.addDependency(seedBuildProfile);

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'S3 access logging out of scope for sample app',
    });
    const nagRules: Record<string, string> = {};
    nagRules['AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]'] =
      'CDK-managed Lambda for S3 auto-delete / EventBridge notifications uses AWS managed policy';
    nagRules['AwsSolutions-IAM5[Resource::*]'] =
      'ec2:DescribeImages (SSM aws:ec2:image async validation of the seeded AMI) has no resource-level scoping';
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}
