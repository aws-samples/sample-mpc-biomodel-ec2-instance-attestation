import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Auth } from './constructs/auth';
import { Frontend } from './constructs/frontend';
import { ApiGateway } from './constructs/api';

export interface FrontendStackProps extends cdk.StackProps {
  /** API endpoint from the BackendStack (Mode 1). */
  readonly apiEndpoint?: string;
  readonly userPoolId?: string;
  readonly userPoolClientId?: string;
  readonly identityPoolId?: string;

  /** Existing-EC2 mode (Mode 2): stand up API GW + NLB pointing at a running instance. */
  readonly existingVpcId?: string;
  readonly backendPrivateIp?: string;
  readonly subnetIds?: string[];
  readonly backendPort?: number;

  /** Skip creating Cognito (e.g. when reusing an existing pool). */
  readonly skipAuth?: boolean;
}

/**
 * Frontend (Amplify) stack.
 *
 * Mode 1: consume apiEndpoint + Cognito ids from the BackendStack.
 * Mode 2: point a fresh API Gateway + NLB at an existing backend EC2 private IP
 *         (dev/testing without the full pipeline).
 */
export class FrontendStack extends cdk.Stack {
  public readonly amplifyAppUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps = {}) {
    super(scope, id, props);

    // Resolve the API endpoint (Mode 1 direct, or Mode 2 via a new API GW)
    let apiEndpoint = props.apiEndpoint;
    if (!apiEndpoint && props.existingVpcId && props.backendPrivateIp && props.subnetIds) {
      const api = new ApiGateway(this, 'Api', {
        existingVpcId: props.existingVpcId,
        backendPrivateIp: props.backendPrivateIp,
        subnetIds: props.subnetIds,
        backendPort: props.backendPort,
      });
      apiEndpoint = api.apiEndpoint;
    }

    // Resolve Cognito: reuse provided ids, else self-contained pool
    let userPoolId = props.userPoolId;
    let userPoolClientId = props.userPoolClientId;
    let identityPoolId = props.identityPoolId;
    if (!props.skipAuth && !userPoolId) {
      const auth = new Auth(this, 'Auth', { accountId: this.account, region: this.region });
      userPoolId = auth.userPool.userPoolId;
      userPoolClientId = auth.userPoolClient.userPoolClientId;
      identityPoolId = auth.identityPool.ref;
    }

    const frontend = new Frontend(this, 'Frontend', {
      apiEndpoint,
      region: this.region,
      // Pass ids as strings via a light import wrapper is unnecessary — the
      // Amplify env vars only need the raw string values.
      userPool: userPoolId ? ({ userPoolId } as any) : undefined,
      userPoolClient: userPoolClientId ? ({ userPoolClientId } as any) : undefined,
      identityPoolId,
    });

    this.amplifyAppUrl = frontend.appUrl;

    new cdk.CfnOutput(this, 'AmplifyAppId', { value: frontend.amplifyApp.attrAppId });
    new cdk.CfnOutput(this, 'AmplifyAppUrl', { value: frontend.appUrl });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: apiEndpoint || '' });
    if (userPoolId) new cdk.CfnOutput(this, 'UserPoolId', { value: userPoolId });
    if (userPoolClientId) new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClientId });
    if (identityPoolId) new cdk.CfnOutput(this, 'IdentityPoolId', { value: identityPoolId });
  }
}
