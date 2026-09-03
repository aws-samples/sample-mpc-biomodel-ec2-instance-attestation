import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface NotificationsProps {
  readonly envName?: string;
}

/**
 * Notification system (replaces scripts/setup-notifications.sh).
 *
 * Biophysicist -> Biologist AMI-update notification flow:
 *   - custom EventBridge bus `boltz-events`
 *   - SNS topic `boltz-notifications`
 *   - a handler Lambda that appends events into an SSM parameter the frontend polls
 *   - an EventBridge rule routing AMI-update / deployment events to the Lambda
 *   - the SSM notification queue parameter
 */
export class Notifications extends Construct {
  public readonly eventBus: events.EventBus;
  public readonly topic: sns.Topic;
  public readonly handler: lambda.Function;
  public readonly notificationParam: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: NotificationsProps = {}) {
    super(scope, id);

    const env = props.envName ?? 'prod';

    // ==================== Event bus + SNS topic ====================
    this.eventBus = new events.EventBus(this, 'EventBus', { eventBusName: 'boltz-events' });
    this.topic = new sns.Topic(this, 'Topic', {
      topicName: 'boltz-notifications',
      masterKey: undefined,
    });

    // ==================== SSM notification queue (frontend polls this) ====================
    this.notificationParam = new ssm.StringParameter(this, 'NotificationQueue', {
      parameterName: `/boltz/notifications/${env}`,
      stringValue: JSON.stringify({ notifications: [] }),
      description: 'Boltz notification queue for the frontend',
    });

    // ==================== Handler Lambda ====================
    this.handler = new lambda.Function(this, 'HandlerFn', {
      functionName: 'boltz-notification-handler',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: { ENVIRONMENT: env },
      code: lambda.Code.fromInline(NOTIFICATION_HANDLER_CODE),
    });

    // Lambda reads/writes the /boltz/* SSM parameters
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/boltz/*`,
      ],
    }));

    // ==================== EventBridge rule -> Lambda ====================
    new events.Rule(this, 'AmiUpdateRule', {
      ruleName: 'boltz-ami-update-notification',
      eventBus: this.eventBus,
      description: 'Route AMI update notifications to the handler Lambda',
      eventPattern: {
        source: ['boltz.biophysicist', 'boltz.deployment', 'boltz.model-workflow'],
        detailType: ['AMI Update', 'Backend Deployment', 'Model Available'],
      },
      targets: [new targets.LambdaFunction(this.handler)],
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SNS2',
      reason: 'SNS server-side encryption out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SNS3',
      reason: 'SNS SSL-only topic policy out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Lambda intentionally pinned to a stable, supported Python runtime (3.13) rather than tracking the newest preview runtime',
    });
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const nagRules: Record<string, string> = {};
    nagRules['AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]'] =
      'Lambda basic execution role is the AWS managed policy for CloudWatch Logs';
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:ssm:${region}:${account}:parameter/boltz/*]`] =
      'Notification handler reads/writes the /boltz/* SSM parameter namespace';
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}

// This template literal holds Python source for an inline Lambda. Any `{...}` inside
// are Python f-string fields, not JavaScript template placeholders, so there is
// intentionally no `${}` interpolation here.
// nosemgrep: missing-template-string-indicator
const NOTIFICATION_HANDLER_CODE = `
import json
import os
from datetime import datetime, timezone
import boto3

ssm = boto3.client('ssm')

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    environment = os.environ.get('ENVIRONMENT', 'prod')
    param_name = f"/boltz/notifications/{environment}"

    detail = event.get('detail', {})
    notification = {
        'id': event.get('id', str(datetime.now(timezone.utc).timestamp())),
        'type': detail.get('type', 'ami-update'),
        'timestamp': event.get('time', datetime.now(timezone.utc).isoformat()),
        'source': event.get('source', 'boltz.biophysicist'),
        'title': detail.get('title', 'New Backend Available'),
        'message': detail.get('message', 'A new backend AMI has been deployed'),
        'ami_id': detail.get('ami_id', ''),
        'pcr_values': detail.get('pcr_values', {}),
        'action_required': detail.get('action_required', True),
        'read': False,
    }

    try:
        response = ssm.get_parameter(Name=param_name)
        data = json.loads(response['Parameter']['Value'])
    except Exception:
        data = {'notifications': []}

    data['notifications'].insert(0, notification)
    data['notifications'] = data['notifications'][:50]

    ssm.put_parameter(Name=param_name, Value=json.dumps(data), Type='String', Overwrite=True)
    print(f"Stored notification: {notification['id']}")
    return {'statusCode': 200, 'body': 'OK'}
`;
