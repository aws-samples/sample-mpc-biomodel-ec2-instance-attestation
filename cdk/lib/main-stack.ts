import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Networking } from './constructs/networking';
import { Storage } from './constructs/storage';
import { Auth } from './constructs/auth';
import { Compute } from './constructs/compute';
import { CodeBuildProject } from './constructs/codebuild';
import { Deployment } from './constructs/codedeploy';
import { DeploymentPipeline } from './constructs/pipeline';
import { Frontend } from './constructs/frontend';
import { Encryption } from './constructs/encryption';
import { DataStorage } from './constructs/data-storage';
import { Notifications } from './constructs/notifications';
import { ModelWorkflow } from './constructs/model-workflow';

/**
 * Combined Boltz Attestation Stack.
 *
 * Backend (attested):
 *   1. Fully private VPC + internal NLB + API Gateway (HTTP API) + VPC Link
 *   2. ASG of NitroTPM-attested EC2 instances (AMI resolved from SSM at launch)
 *   3. S3 bucket for build source + AMI artifacts; SSM params for AMI id + PCRs
 *   4. Cognito (User Pool + Client + Identity Pool) for auth
 *   5. CodeBuild that builds the attested AMI via kiwi-ng and registers it
 *   6. CodeBuild "deployer" that swaps the ASG AMI (SSM) + rolls an instance refresh
 *   7. CodePipeline orchestrating Source (S3) -> Build (AMI) -> Deploy (swap+refresh)
 *
 * Frontend:
 *   8. Amplify hosting for the React/Vite frontend (repo `frontend/`)
 *
 * After deployment:
 *   1. Package + upload source:  ./scripts/package-and-upload.sh
 *   2. Pipeline builds the attested AMI and rolls the ASG to it
 *   3. Deploy the frontend:       ./scripts/deploy-frontend.sh
 */
export class BoltzAttestationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== Storage ====================
    const storage = new Storage(this, 'Storage', {
      accountId: this.account,
      region: this.region,
    });

    // ==================== Authentication ====================
    const auth = new Auth(this, 'Auth', {
      accountId: this.account,
      region: this.region,
    });

    // ==================== Networking ====================
    const networking = new Networking(this, 'Networking', {
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.userPoolClient.userPoolClientId,
    });

    // ==================== CodeBuild (AMI builder) ====================
    const codebuild = new CodeBuildProject(this, 'CodeBuild', {
      sourceBucket: storage.sourceBucket,
      amiIdParam: storage.amiIdParam,
      pcrValuesParam: storage.pcrValuesParam,
      buildProfileParam: storage.buildProfileParam,
    });

    // ==================== Compute ====================
    const compute = new Compute(this, 'Compute', {
      vpc: networking.vpc,
      securityGroup: networking.ec2SecurityGroup,
      sourceBucket: storage.sourceBucket,
      amiIdParam: storage.amiIdParam,
      pcrValuesParam: storage.pcrValuesParam,
      amiParamSeed: storage.seedAmiParam,
      nlbListener: networking.nlbListener,
      backendPort: networking.backendPort,
    });

    // ==================== Deployment (AMI swap + refresh via Step Functions) ====
    const deployment = new Deployment(this, 'Deployment', {
      asg: compute.asg,
      amiIdParam: storage.amiIdParam,
      pcrValuesParam: storage.pcrValuesParam,
      sourceBucket: storage.sourceBucket,
    });

    // ==================== CodePipeline ====================
    const pipelineConstruct = new DeploymentPipeline(this, 'Pipeline', {
      sourceBucket: storage.sourceBucket,
      buildProject: codebuild.buildProject,
      deployStateMachine: deployment.stateMachine,
    });

    // ==================== Frontend (Amplify) ====================
    const frontend = new Frontend(this, 'Frontend', {
      apiEndpoint: networking.getApiEndpoint(this.region),
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      identityPoolId: auth.identityPool.ref,
      region: this.region,
      // Buckets are CDK auto-named and created after this construct, so the real name
      // is injected at deploy time by cdk/scripts/deploy-frontend.sh
      // (VITE_SEQUENCES_BUCKET / VITE_MODELS_BUCKET from stack outputs), not baked here.
    });

    // ==================== Encryption (KMS) ====================
    const encryption = new Encryption(this, 'Encryption', { envName: 'prod' });

    // ==================== Application Data (S3) ====================
    const dataStorage = new DataStorage(this, 'DataStorage', {
      envName: 'prod',
      frontendUrl: frontend.appUrl,
    });

    // Grant S3 access to the roles now that the (auto-named) buckets exist — scoped to
    // the real bucket ARNs, not a fixed name prefix. Cognito users read/write their
    // sequences and read models; the EC2 backend reads encrypted weights.
    dataStorage.sequencesBucket.grantReadWrite(auth.authenticatedRole);
    dataStorage.modelsBucket.grantRead(auth.authenticatedRole);
    dataStorage.modelsBucket.grantRead(compute.ec2Role);
    // The attested backend fetches the encrypted sequence from S3 at prediction time (the
    // client sends s3_bucket + s3_key instead of the ciphertext inline), then decrypts it
    // under attestation. The objects are KMS-sealed and only decryptable under attestation,
    // so read access to the (encrypted) sequences is safe.
    dataStorage.sequencesBucket.grantRead(compute.ec2Role);

    // ==================== Backend runtime config (SSM) ====================
    // The Amplify origin the backend must allow through CORS is only known once the
    // frontend exists. Publish it to an SSM parameter that the instance reads at boot
    // (boltz-config.service -> /opt/boltz/bin/write-runtime-config.py -> CORS_ORIGINS in
    // /etc/boltz/environment) using its own IAM role over the SSM VPC endpoint. This
    // keeps CORS working under Zero Operator Access (no SSH/SSM shell) and across ASG
    // instance replacement, without baking the origin into the AMI. The parameter name
    // is the fixed constant the boot script reads.
    const corsOriginsParam = new ssm.StringParameter(this, 'CorsOriginsParam', {
      parameterName: '/boltz-attestation/cors-origins',
      stringValue: frontend.appUrl,
      description: 'Allowed CORS origin(s) for the Boltz backend (the Amplify frontend URL)',
    });
    corsOriginsParam.grantRead(compute.ec2Role);

    // ==================== Notifications (EventBridge + SNS + Lambda) ====================
    const notifications = new Notifications(this, 'Notifications', { envName: 'prod' });

    // ==================== Model Update Workflow (Step Functions) ====================
    new ModelWorkflow(this, 'ModelWorkflow', {
      envName: 'prod',
      modelsBucket: dataStorage.modelsBucket,
      modelKey: encryption.modelKey,
      eventBus: notifications.eventBus,
    });

    // cdk-nag: the S3 grant*() calls above expand to the bucket ARN + an object-level
    // "<bucket>.Arn>/*" wildcard, which is expected for read/write of user objects.
    this.node.addMetadata('aws:cdk:acknowledged-rules', {
      'AwsSolutions-IAM5[Resource::<DataStorageSequencesBucketE2623AC4.Arn>/*]':
        'Cognito users read/write their own encrypted sequence objects across the bucket',
      'AwsSolutions-IAM5[Resource::<DataStorageModelsBucket*.Arn>/*]':
        'Roles read encrypted model weight objects across the models bucket',
    });

    // ==================== Outputs ====================
    new cdk.CfnOutput(this, 'VpcId', { value: networking.vpc.vpcId, description: 'VPC ID' });
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: storage.sourceBucket.bucketName,
      description: 'S3 bucket for build source + AMI artifacts',
    });
    new cdk.CfnOutput(this, 'CodeBuildProject', {
      value: codebuild.buildProject.projectName,
      description: 'CodeBuild project that builds the attested AMI',
    });
    // Exposed so teardown (scripts/cleanup.sh) can find the reserved-capacity fleet
    // deterministically from cdk-outputs.json and delete it up front (a fleet can sit
    // in PENDING_DELETION for ~1h, so we drain it in parallel rather than making
    // CloudFormation wait on it). The fleet is intentionally not given a fixed name.
    new cdk.CfnOutput(this, 'CodeBuildFleetName', {
      value: codebuild.fleet.fleetName,
      description: 'CodeBuild reserved-capacity fleet name (for teardown)',
    });
    new cdk.CfnOutput(this, 'CodeBuildFleetArn', {
      value: codebuild.fleet.fleetArn,
      description: 'CodeBuild reserved-capacity fleet ARN (for teardown)',
    });
    new cdk.CfnOutput(this, 'DeployStateMachine', {
      value: deployment.stateMachine.stateMachineArn,
      description: 'Step Functions state machine that swaps the ASG AMI + polls the refresh',
    });
    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipelineConstruct.pipeline.pipelineName,
      description: 'CodePipeline name',
    });
    new cdk.CfnOutput(this, 'AsgName', {
      value: compute.asg.autoScalingGroupName,
      description: 'Auto Scaling Group Name',
    });
    new cdk.CfnOutput(this, 'AmiIdParam', {
      value: Storage.AMI_ID_PARAM_NAME,
      description: 'SSM parameter holding the current attested AMI id',
    });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: networking.getApiEndpoint(this.region),
      description: 'API Gateway endpoint URL',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: auth.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: auth.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: auth.identityPool.ref,
      description: 'Cognito Identity Pool ID',
    });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: auth.getCognitoDomainUrl(this.region),
      description: 'Cognito Hosted UI Domain',
    });
    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: frontend.amplifyApp.attrAppId,
      description: 'Amplify Application ID',
    });
    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: frontend.appUrl,
      description: 'Amplify App URL (connect Git repo or run deploy-frontend.sh to enable)',
    });
    new cdk.CfnOutput(this, 'DeploymentInstructions', {
      value: `Upload source: ./scripts/package-and-upload.sh ${storage.sourceBucket.bucketName}`,
      description: 'How to trigger an attested AMI build + rollout',
    });
    new cdk.CfnOutput(this, 'SequenceKmsKeyArn', {
      value: encryption.sequenceKey.keyArn,
      description: 'KMS key ARN for sequence encryption (alias/boltz-sequence-key)',
    });
    new cdk.CfnOutput(this, 'ModelKmsKeyArn', {
      value: encryption.modelKey.keyArn,
      description: 'KMS key ARN for model weights (alias/boltz-model-key)',
    });
    new cdk.CfnOutput(this, 'SequencesBucketName', {
      value: dataStorage.sequencesBucket.bucketName,
      description: 'S3 bucket for encrypted sequences (set as VITE_S3_BUCKET)',
    });
    new cdk.CfnOutput(this, 'ModelsBucketName', {
      value: dataStorage.modelsBucket.bucketName,
      description: 'S3 bucket for model weights',
    });
    new cdk.CfnOutput(this, 'AuthenticatedRoleArn', {
      value: auth.authenticatedRole.roleArn,
      description: 'Cognito authenticated role ARN (BoltzClientPolicy)',
    });
    new cdk.CfnOutput(this, 'EventBusName', {
      value: notifications.eventBus.eventBusName,
      description: 'EventBridge bus for Boltz notifications',
    });
    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: notifications.topic.topicArn,
      description: 'SNS topic for Boltz notifications',
    });
  }
}
