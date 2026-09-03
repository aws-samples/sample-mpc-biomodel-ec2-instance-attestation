import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AuthProps {
  readonly accountId: string;
  readonly region: string;
}

/**
 * Cognito authentication for the Amplify-hosted React frontend.
 *
 * Creates a User Pool + Client (used as the API Gateway JWT authorizer audience)
 * and an Identity Pool so the frontend's amplify-config.ts can obtain temporary
 * AWS credentials for the SDK calls it makes (S3 / SSM / KMS).
 */
export class Auth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly identityPool: cognito.CfnIdentityPool;
  /** Role assumed by authenticated (signed-in) Cognito users via the Identity Pool. */
  public readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    // ==================== Cognito User Pool ====================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'boltz-attestation-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Force LITE tier so the legacy AdminCreateUserConfig / AutoVerifiedAttributes
    // properties are honoured (ESSENTIALS tier ignores them and blocks self-signup).
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride('UserPoolTier', 'LITE');
    cfnUserPool.addPropertyOverride('AdminCreateUserConfig.AllowAdminCreateUserOnly', false);
    cfnUserPool.addPropertyOverride('AutoVerifiedAttributes', ['email']);
    // Self-signup is enabled purely declaratively via the three overrides above
    // (UserPoolTier=LITE makes Cognito respect AllowAdminCreateUserOnly=false), so a
    // plain `cdk deploy` yields a working self-signup pool. No custom resource needed.
    //
    // If you ever see "SignUp is not permitted for this user pool" AFTER a clean
    // deploy, check whether an external actor is flipping AllowAdminCreateUserOnly
    // back to true (CloudTrail: UpdateUserPool). Some AWS accounts run automated
    // security guardrails that disable open self-signup pools account-wide; that is
    // an account-policy matter, not a bug in this template. In a standard account
    // nothing reverts this and self-signup works as configured.

    // ==================== User Pool Client ====================
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['http://localhost:3000/', 'https://localhost:3000/'],
        logoutUrls: ['http://localhost:3000/', 'https://localhost:3000/'],
      },
    });

    // ==================== User Pool Domain ====================
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: `boltz-attestation-${props.accountId}`,
      },
    });

    // ==================== Identity Pool (federated AWS credentials) ====================
    // The frontend uses aws-amplify + AWS SDK v3 clients (S3/SSM/KMS) which need
    // an Identity Pool to exchange the User Pool JWT for temporary credentials.
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: 'boltz_attestation_identity_pool',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });

    // ==================== Authenticated Role + BoltzClientPolicy ====================
    // Replaces scripts/setup-iam.sh: the role signed-in users assume via the
    // Identity Pool, plus the inline policy granting KMS/S3/SSM access the frontend
    // needs. KMS encrypt is scoped by the `application=boltz-protein-folding`
    // encryption-context condition.
    const region = props.region;
    const account = props.accountId;

    this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'Role for authenticated Boltz frontend users',
    });

    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowKMSEncrypt',
      effect: iam.Effect.ALLOW,
      actions: ['kms:Encrypt', 'kms:GenerateDataKey'],
      resources: [`arn:aws:kms:${region}:${account}:key/*`],
      conditions: {
        StringEquals: { 'kms:EncryptionContext:application': 'boltz-protein-folding' },
      },
    }));
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowKMSDescribeAndPolicy',
      effect: iam.Effect.ALLOW,
      actions: ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy'],
      resources: [`arn:aws:kms:${region}:${account}:key/*`],
    }));
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowKMSListAliases',
      effect: iam.Effect.ALLOW,
      actions: ['kms:ListAliases'],
      resources: ['*'],
    }));
    // NOTE: S3 access for the authenticated role is granted by the stack AFTER the
    // buckets are created (bucket.grantReadWrite(authenticatedRole)), scoped to the
    // actual (CDK auto-generated) bucket ARNs — not a fixed `boltz-*-*` name prefix.
    // See main-stack.ts / backend-stack.ts. This construct is created before the
    // buckets, so it cannot reference their ARNs here.
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      // Backend-owned SSM reads (e.g. model-download progress under /boltz/models/*).
      // The PCR trust store is NOT here anymore — it lives in the browser.
      sid: 'AllowSSMReadBackendParams',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/boltz/*`],
    }));
    // NOTE: The PCR trust store moved to browser-local storage (frontend
    // services/trustStore.ts), so the authenticated role no longer needs SSM WRITE
    // access to the trust-store parameter paths. Removing it tightens the trust
    // boundary — the client's "PCRs I trust" baseline is never written to a
    // backend-controlled parameter. SSM READ (AllowSSMReadTrustStore above) is kept
    // only for backend-owned reads like model-download progress under /boltz/models/*.
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSSMDescribeParameters',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:DescribeParameters'],
      resources: ['*'],
    }));
    // The frontend (ModelManager) starts + polls the model-update Step Function
    // directly via the AWS SDK with these Cognito credentials. Scope to the named
    // state machine + its executions. (Name matches ModelWorkflow's stateMachineName.)
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowStartModelWorkflow',
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [`arn:aws:states:${region}:${account}:stateMachine:boltz-model-update-workflow`],
    }));
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowDescribeModelWorkflowExecutions',
      effect: iam.Effect.ALLOW,
      actions: ['states:DescribeExecution'],
      resources: [`arn:aws:states:${region}:${account}:execution:boltz-model-update-workflow:*`],
    }));

    // Attach the authenticated role to the Identity Pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: this.identityPool.ref,
      roles: { authenticated: this.authenticatedRole.roleArn },
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-COG2',
      reason: 'MFA not required for sample/demo application',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-COG3',
      reason: 'Advanced security mode (Plus tier) not needed for sample application',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-COG8',
      reason: 'Cognito Plus tier not needed for sample application',
    });
    const authReason =
      'Cognito authenticated-user policy (ports setup-iam.sh): KMS gated by the boltz-protein-folding encryption context, S3 uses env-suffixed bucket wildcards, list/describe APIs require Resource::*';
    const nagRules: Record<string, string> = {};
    for (const appliesTo of [
      'Resource::*',
      `Resource::arn:aws:kms:${props.region}:${props.accountId}:key/*`,
      'Resource::arn:aws:s3:::boltz-sequences-*',
      'Resource::arn:aws:s3:::boltz-sequences-*/*',
      'Resource::arn:aws:s3:::boltz-models-*',
      'Resource::arn:aws:s3:::boltz-models-*/*',
      `Resource::arn:aws:ssm:${props.region}:${props.accountId}:parameter/boltz/*`,
      `Resource::arn:aws:states:${props.region}:${props.accountId}:execution:boltz-model-update-workflow:*`,
    ]) {
      nagRules[`AwsSolutions-IAM5[${appliesTo}]`] = authReason;
    }
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }

  public getCognitoDomainUrl(region: string): string {
    return `https://${this.userPoolDomain.domainName}.auth.${region}.amazoncognito.com`;
  }
}
