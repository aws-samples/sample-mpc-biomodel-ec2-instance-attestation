import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';

export interface ApiGatewayProps {
  /** Existing VPC id to attach the NLB/VPC Link to. */
  readonly existingVpcId: string;
  /** Private IP of the existing backend EC2 instance. */
  readonly backendPrivateIp: string;
  /** Subnet ids (>=2) for the internal NLB. */
  readonly subnetIds: string[];
  /** Backend port. @default 8000 */
  readonly backendPort?: number;
}

/**
 * Standalone API Gateway + VPC Link + internal NLB pointing at an EXISTING
 * backend EC2 private IP. Used by the frontend "dev" stack to test the Amplify
 * frontend against an already-running attested instance without standing up the
 * full pipeline.
 */
export class ApiGateway extends Construct {
  public readonly apiEndpoint: string;
  public readonly nlb: elbv2.NetworkLoadBalancer;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    const backendPort = props.backendPort ?? 8000;
    const region = cdk.Stack.of(this).region;

    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', { vpcId: props.existingVpcId });

    this.nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnets: props.subnetIds.map((s, i) => ec2.Subnet.fromSubnetId(this, `Subnet${i}`, s)) },
    });

    const listener = this.nlb.addListener('Listener', { port: 80 });
    listener.addTargets('BackendIp', {
      port: backendPort,
      targets: [new elbv2_targets.IpTarget(props.backendPrivateIp, backendPort)],
      healthCheck: { protocol: elbv2.Protocol.HTTP, path: '/health' },
    });

    const sg = new ec2.SecurityGroup(this, 'VpcLinkSg', { vpc, allowAllOutbound: true });

    const vpcLink = new apigatewayv2.CfnVpcLink(this, 'VpcLink', {
      name: 'boltz-attestation-dev-vpc-link',
      subnetIds: props.subnetIds,
      securityGroupIds: [sg.securityGroupId],
    });

    const httpApi = new apigatewayv2.CfnApi(this, 'HttpApi', {
      name: 'boltz-attestation-dev-api',
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: 86400,
      },
    });

    const integration = new apigatewayv2.CfnIntegration(this, 'NlbIntegration', {
      apiId: httpApi.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'ANY',
      integrationUri: listener.listenerArn,
      connectionType: 'VPC_LINK',
      connectionId: vpcLink.ref,
      payloadFormatVersion: '1.0',
    });

    new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
      apiId: httpApi.ref,
      routeKey: '$default',
      target: `integrations/${integration.ref}`,
      authorizationType: 'NONE',
    });

    new apigatewayv2.CfnStage(this, 'Stage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
    });

    this.apiEndpoint = `https://${httpApi.ref}.execute-api.${region}.amazonaws.com`;
  }
}
