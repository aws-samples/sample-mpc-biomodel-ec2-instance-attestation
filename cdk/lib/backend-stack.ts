import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Networking } from './constructs/networking';
import { Storage } from './constructs/storage';
import { Auth } from './constructs/auth';
import { Compute } from './constructs/compute';
import { CodeBuildProject } from './constructs/codebuild';
import { Deployment } from './constructs/codedeploy';
import { DeploymentPipeline } from './constructs/pipeline';
import { Encryption } from './constructs/encryption';
import { DataStorage } from './constructs/data-storage';
import { Notifications } from './constructs/notifications';
import { ModelWorkflow } from './constructs/model-workflow';

/**
 * Backend-only stack: everything except the Amplify frontend.
 *
 * Exposes apiEndpoint / userPoolId / userPoolClientId / identityPoolId so the
 * FrontendStack can consume them.
 */
export class BackendStack extends cdk.Stack {
  public readonly apiEndpoint: string;
  public readonly userPoolId: string;
  public readonly userPoolClientId: string;
  public readonly identityPoolId: string;
  public readonly cognitoDomain: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage', {
      accountId: this.account,
      region: this.region,
    });

    const auth = new Auth(this, 'Auth', {
      accountId: this.account,
      region: this.region,
    });

    const networking = new Networking(this, 'Networking', {
      userPoolId: auth.userPool.userPoolId,
      userPoolClientId: auth.userPoolClient.userPoolClientId,
    });

    const codebuild = new CodeBuildProject(this, 'CodeBuild', {
      sourceBucket: storage.sourceBucket,
      amiIdParam: storage.amiIdParam,
      pcrValuesParam: storage.pcrValuesParam,
      buildProfileParam: storage.buildProfileParam,
    });

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

    const deployment = new Deployment(this, 'Deployment', {
      asg: compute.asg,
      amiIdParam: storage.amiIdParam,
      pcrValuesParam: storage.pcrValuesParam,
      sourceBucket: storage.sourceBucket,
    });

    new DeploymentPipeline(this, 'Pipeline', {
      sourceBucket: storage.sourceBucket,
      buildProject: codebuild.buildProject,
      deployStateMachine: deployment.stateMachine,
    });

    // ==================== Encryption / Data / Notifications / Model workflow ====================
    const encryption = new Encryption(this, 'Encryption', { envName: 'prod' });
    const dataStorage = new DataStorage(this, 'DataStorage', {
      envName: 'prod',
      // Frontend URL not known in the split backend stack; localhost dev origins
      // still apply and the CORS rule can be extended after the frontend deploys.
    });
    // Grant S3 access scoped to the real (auto-named) bucket ARNs.
    dataStorage.sequencesBucket.grantReadWrite(auth.authenticatedRole);
    dataStorage.modelsBucket.grantRead(auth.authenticatedRole);
    dataStorage.modelsBucket.grantRead(compute.ec2Role);
    const notifications = new Notifications(this, 'Notifications', { envName: 'prod' });
    new ModelWorkflow(this, 'ModelWorkflow', {
      envName: 'prod',
      modelsBucket: dataStorage.modelsBucket,
      modelKey: encryption.modelKey,
      eventBus: notifications.eventBus,
    });

    // cdk-nag: S3 grant*() above expand to a "<bucket>.Arn>/*" object wildcard (expected).
    this.node.addMetadata('aws:cdk:acknowledged-rules', {
      'AwsSolutions-IAM5[Resource::<DataStorageSequencesBucketE2623AC4.Arn>/*]':
        'Cognito users read/write their own encrypted sequence objects across the bucket',
      'AwsSolutions-IAM5[Resource::<DataStorageModelsBucket*.Arn>/*]':
        'Roles read encrypted model weight objects across the models bucket',
    });

    this.apiEndpoint = networking.getApiEndpoint(this.region);
    this.userPoolId = auth.userPool.userPoolId;
    this.userPoolClientId = auth.userPoolClient.userPoolClientId;
    this.identityPoolId = auth.identityPool.ref;
    this.cognitoDomain = auth.getCognitoDomainUrl(this.region);

    // ==================== Outputs (with cross-stack exports) ====================
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: storage.sourceBucket.bucketName,
      exportName: 'BoltzAttestation-SourceBucket',
    });
    new cdk.CfnOutput(this, 'AsgName', { value: compute.asg.autoScalingGroupName });
    // Auto-generated bucket names, consumed by deploy-frontend.sh (VITE_* injection).
    new cdk.CfnOutput(this, 'SequencesBucketName', { value: dataStorage.sequencesBucket.bucketName });
    new cdk.CfnOutput(this, 'ModelsBucketName', { value: dataStorage.modelsBucket.bucketName });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.apiEndpoint,
      exportName: 'BoltzAttestation-ApiEndpoint',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPoolId,
      exportName: 'BoltzAttestation-UserPoolId',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClientId,
      exportName: 'BoltzAttestation-UserPoolClientId',
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPoolId,
      exportName: 'BoltzAttestation-IdentityPoolId',
    });
  }
}
