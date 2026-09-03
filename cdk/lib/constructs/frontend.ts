import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface FrontendProps {
  /** API Gateway endpoint URL that fronts the attested backend. */
  readonly apiEndpoint?: string;
  /** Cognito User Pool. */
  readonly userPool?: cognito.IUserPool;
  /** Cognito User Pool Client. */
  readonly userPoolClient?: cognito.IUserPoolClient;
  /** Cognito Identity Pool id (for AWS SDK creds in the frontend). */
  readonly identityPoolId?: string;
  /** AWS region (used by the frontend AWS SDK clients). */
  readonly region?: string;
  /** S3 bucket for encrypted sequences (VITE_S3_BUCKET). */
  readonly sequencesBucketName?: string;
  /** Branch to deploy. @default main */
  readonly branch?: string;
}

/**
 * AWS Amplify hosting for the Boltz React/Vite frontend (repo `frontend/`).
 *
 * The build spec runs `npm ci && npm run build` from the `frontend/` app root and
 * publishes `frontend/dist`. Cognito + backend config is injected as VITE_*
 * environment variables matching frontend/.env.example / amplify-config.ts:
 *   VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID, VITE_COGNITO_IDENTITY_POOL_ID,
 *   VITE_AWS_REGION, VITE_BACKEND_URL.
 *
 * The Git repository is connected manually in the Amplify console (or code is
 * pushed via scripts/deploy-frontend.sh) — the CDK does not embed a repo token.
 */
export class Frontend extends Construct {
  public readonly amplifyApp: amplify.CfnApp;
  public readonly amplifyBranch: amplify.CfnBranch;
  public readonly appUrl: string;

  constructor(scope: Construct, id: string, props: FrontendProps = {}) {
    super(scope, id);

    const branch = props.branch || 'main';

    const amplifyRole = new iam.Role(this, 'AmplifyRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: 'Role for Amplify to build and host the Boltz frontend',
    });

    this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: 'boltz-attestation-frontend',
      description: 'Boltz Protein Folding Attestation Demo Frontend',
      iamServiceRole: amplifyRole.roleArn,

      // Build settings for the Vite/React app rooted at app/frontend/.
      // NOTE: the top-level `frontend:` key is Amplify's buildspec schema keyword, not
      // a path — only the cd/baseDirectory/cache paths point at the app directory.
      buildSpec: cdk.Fn.sub(`
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - cd app/frontend
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: app/frontend/dist
    files:
      - '**/*'
  cache:
    paths:
      - app/frontend/node_modules/**/*
`),

      environmentVariables: [
        { name: 'VITE_BACKEND_URL', value: props.apiEndpoint || '' },
        { name: 'VITE_COGNITO_USER_POOL_ID', value: props.userPool?.userPoolId || '' },
        { name: 'VITE_COGNITO_CLIENT_ID', value: props.userPoolClient?.userPoolClientId || '' },
        { name: 'VITE_COGNITO_IDENTITY_POOL_ID', value: props.identityPoolId || '' },
        { name: 'VITE_AWS_REGION', value: props.region || cdk.Stack.of(this).region },
        { name: 'VITE_S3_BUCKET', value: props.sequencesBucketName || '' },
        // No VITE_SSM_TRUST_STORE_PATH: the PCR trust store is the relying party's own
        // baseline and lives in browser-local storage (frontend services/trustStore.ts),
        // never in a backend-owned SSM parameter.
        {
          name: '_LIVE_UPDATES',
          value: JSON.stringify([{ pkg: '@aws-amplify/cli', type: 'npm', version: 'latest' }]),
        },
      ],

      // SPA routing
      customRules: [
        {
          source: '</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>',
          target: '/index.html',
          status: '200',
        },
      ],

      platform: 'WEB',
    });

    this.amplifyBranch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: this.amplifyApp.attrAppId,
      branchName: branch,
      enableAutoBuild: true,
      enablePullRequestPreview: false,
      stage: 'PRODUCTION',
      environmentVariables: [{ name: 'AMPLIFY_MONOREPO_APP_ROOT', value: '.' }],
    });

    this.appUrl = `https://${branch}.${this.amplifyApp.attrDefaultDomain}`;
  }
}
