#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BackendStack } from '../lib/backend-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BoltzAttestationStack } from '../lib/main-stack';

/**
 * Boltz NitroTPM Attestation CDK App
 *
 * ============================================================================
 * DEPLOYMENT OPTIONS
 * ============================================================================
 *
 * 1. Deploy everything (combined stack):
 *    npx cdk deploy BoltzAttestationStack
 *
 * 2. Deploy backend only:
 *    npx cdk deploy BoltzAttestationBackend
 *
 * 3. Deploy frontend with full backend:
 *    npx cdk deploy BoltzAttestationBackend BoltzAttestationFrontend
 *
 * 4. Deploy frontend pointing to an EXISTING EC2 instance (testing mode):
 *    npx cdk deploy BoltzAttestationFrontendDev \
 *      -c vpcId=vpc-xxxxx \
 *      -c backendIp=10.0.1.100 \
 *      -c subnetIds=subnet-aaa,subnet-bbb
 * ============================================================================
 */

const app = new cdk.App();

// cdk-nag policy checks
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Context params for the existing-EC2 frontend dev mode
const existingVpcId = app.node.tryGetContext('vpcId');
const backendPrivateIp = app.node.tryGetContext('backendIp');
const subnetIdsStr = app.node.tryGetContext('subnetIds');
const subnetIds = subnetIdsStr ? subnetIdsStr.split(',') : undefined;
const backendPort = parseInt(app.node.tryGetContext('backendPort') || '8000');

// NOTE: the kiwi build profile ('prod' | 'foa') is NOT a deploy-time/context value.
// It is a build-time configuration held in the /boltz-attestation/build-profile SSM
// parameter (seeded to 'prod' = Zero Operator Access) and read by CodeBuild at build
// start. Flip it with `aws ssm put-parameter --name /boltz-attestation/build-profile
// --value foa --overwrite`, then trigger a build. No code change, no redeploy.

// Option 1: Combined stack (all-in-one)
new BoltzAttestationStack(app, 'BoltzAttestationStack', {
  env,
  description: 'Boltz NitroTPM Attestation Demo - Combined Stack',
});

// Option 2: Separate backend + frontend stacks
const backendStack = new BackendStack(app, 'BoltzAttestationBackend', {
  env,
  description: 'Boltz NitroTPM Attestation Demo - Backend Infrastructure',
});

new FrontendStack(app, 'BoltzAttestationFrontend', {
  env,
  description: 'Boltz NitroTPM Attestation Demo - Frontend (Amplify)',
  apiEndpoint: backendStack.apiEndpoint,
  userPoolId: backendStack.userPoolId,
  userPoolClientId: backendStack.userPoolClientId,
  identityPoolId: backendStack.identityPoolId,
});

// Option 3: Frontend only, pointing to an existing EC2 (dev/testing)
if (existingVpcId && backendPrivateIp && subnetIds) {
  new FrontendStack(app, 'BoltzAttestationFrontendDev', {
    env,
    description: 'Boltz NitroTPM Attestation Demo - Frontend Dev (existing EC2)',
    existingVpcId,
    backendPrivateIp,
    subnetIds,
    backendPort,
  });
}

cdk.Tags.of(app).add('Project', 'BoltzAttestationDemo');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
