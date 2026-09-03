import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './storage';

export interface ComputeProps {
  readonly vpc: ec2.Vpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly sourceBucket: s3.Bucket;
  readonly amiIdParam: ssm.IStringParameter;
  readonly pcrValuesParam: ssm.IStringParameter;
  /**
   * The seed custom resource that creates the AMI SSM param (with aws:ec2:image
   * datatype). The launch template's resolve:ssm AMI depends on this so the parameter
   * exists before EC2 validates the launch template.
   */
  readonly amiParamSeed: Construct;
  readonly nlbListener: elbv2.NetworkListener;
  /** Backend app port. @default 8000 */
  readonly backendPort?: number;
  /**
   * NitroTPM-capable instance type. The Boltz backend expects a GPU for the
   * Boltz model; g5.4xlarge matches the repo's documented launch.
   *
   * If set, this single type is used as-is (no mixed-instances fallback). If NOT set,
   * the ASG uses a MixedInstancesPolicy across a prioritized list of single-GPU
   * families (see GPU_INSTANCE_PRIORITY) so it can still launch when the preferred
   * family has no capacity in the VPC's isolated subnets — which is what forced an
   * earlier manual fallback to a CPU instance.
   * @default MixedInstancesPolicy over g7.4xlarge -> g6e.4xlarge -> g6.4xlarge -> g5.4xlarge -> ...
   */
  readonly instanceType?: ec2.InstanceType;
}

/**
 * Prioritized single-GPU instance types for the Boltz backend, most-preferred first.
 * All are NitroTPM-capable, comparable to g5.4xlarge (1 GPU), and confirmed offerable
 * in us-east-2a/2b. The ASG tries them in order (prioritized allocation) so a capacity
 * shortfall on one family transparently falls through to the next.
 */
const GPU_INSTANCE_PRIORITY = [
  // g7 / g6 / g5 families in 4xlarge -> 2xlarge -> xlarge sizes (g6e excluded). All are
  // single-GPU and NitroTPM-capable. NOTE: the on-demand `prioritized` policy was observed
  // NOT to cascade off the top priority on InsufficientInstanceCapacity (it kept requesting
  // only the first type), so the list LEADS with g5.4xlarge — the most broadly available
  // single-GPU type and the repo's documented default — to guarantee a launch. Larger/newer
  // types follow as fallbacks (by size, then family).
  'g5.4xlarge',
  'g6.4xlarge',
  'g7.4xlarge',
  'g5.2xlarge',
  'g6.2xlarge',
  'g7.2xlarge',
  // g7 has no xlarge size, so the xlarge tier is g5/g6 only.
  'g5.xlarge',
  'g6.xlarge',
];

/**
 * Compute layer: an ASG of NitroTPM-attested EC2 instances behind the internal NLB.
 *
 * The AMI is resolved from an SSM parameter *at launch time* (resolve:ssm), so the
 * pipeline can roll out a new attested image by (1) updating the SSM parameter to
 * the freshly registered AMI id and (2) triggering an ASG instance refresh. The
 * launch template requires IMDSv2 and boots the attested AMI (UEFI + NitroTPM v2.0),
 * which is immutable (read-only erofs root + dm-verity) — so there is no in-place
 * deployment; new code ships as a new AMI.
 */
export class Compute extends Construct {
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly ec2Role: iam.Role;
  public readonly backendPort: number;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    this.backendPort = props.backendPort ?? 8000;

    // ==================== IAM Role ====================
    this.ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // Session Manager access (used by the FOA/dev AMI variant; PROD has no agent)
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Read the AMI id + PCR trust-store parameters
    props.amiIdParam.grantRead(this.ec2Role);
    props.pcrValuesParam.grantRead(this.ec2Role);

    // Read build source from the artifacts bucket. Read access to the (auto-named)
    // models bucket is granted by the stack via modelsBucket.grantRead(ec2Role), scoped
    // to the real bucket ARN — so there is no `boltz-models-*` name-prefix wildcard here.
    this.ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:ListBucket'],
      resources: [
        props.sourceBucket.bucketArn,
        `${props.sourceBucket.bucketArn}/*`,
      ],
    }));

    // NOTE: no IAM kms:Decrypt grant here. Decrypt permission is granted ONLY by each
    // key's own policy, via an Allow scoped to this EC2 role ARN and conditioned on the
    // attested NitroTPM PCRs (added post-deploy through the KMS Policy Editor). That means
    // the role can decrypt a sealed asset only from an instance in the exact measured
    // state — least privilege: the identity policy grants no standing KMS access at all,
    // so there is nothing to widen or leak, and nothing decrypts until a policy is bound.

    // ==================== User Data ====================
    // PROD attested AMIs ignore user-data (no cloud-init); this is consumed only
    // by the FOA/dev AMI variant to set backend env + confirm boot health.
    const userDataScriptPath = path.join(__dirname, '..', '..', 'scripts', 'ec2-user-data.sh');
    const userDataScript = fs.readFileSync(userDataScriptPath, 'utf-8');
    const userData = ec2.UserData.forLinux();
    userData.addCommands(userDataScript);

    // ==================== Launch Template ====================
    // When using a MixedInstancesPolicy the instance type comes from the policy's
    // overrides, so the launch template itself must NOT pin one (a fixed type would be
    // overridden anyway and is misleading). Only set it for the single-type escape hatch.
    const useMixedInstances = props.instanceType === undefined;
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      ...(props.instanceType ? { instanceType: props.instanceType } : {}),
      // Resolve the attested AMI id from SSM at launch time. This is the pivot
      // that lets the pipeline swap AMIs by updating one parameter.
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        Storage.AMI_ID_PARAM_NAME
      ),
      role: this.ec2Role,
      securityGroup: props.securityGroup,
      userData,
      // Enforce IMDSv2 (required by the attestation flow / repo README).
      requireImdsv2: true,
    });

    // The launch template resolves the AMI from SSM (resolve:ssm:/boltz-attestation/ami-id)
    // at creation time, and EC2 validates that alias — it must already exist WITH the
    // aws:ec2:image datatype and a real AMI value. That parameter is seeded by the
    // Storage seed custom resource (amiIdParam depends on it), so make the launch
    // template depend on the seed custom resource; otherwise CFN creates the LT before
    // the seed runs and EC2 rejects it ("The following aliases are invalid:
    // /boltz-attestation/ami-id"). (Depending on the imported param ref is a no-op —
    // it's a dynamic reference, not a CFN resource — so we depend on the seed directly.)
    launchTemplate.node.addDependency(props.amiParamSeed);

    // NitroTPM v2.0 is baked into the AMI at registration time
    // (`register-image --tpm-support v2.0` in upload-ami.sh) and is inherited by
    // every instance launched from it. It is NOT a launch-template property —
    // CloudFormation rejects TpmSupport on AWS::EC2::LaunchTemplate — so there is
    // nothing to set here.

    // ==================== Auto Scaling Group ====================
    // With no explicit instanceType, use a MixedInstancesPolicy across a prioritized
    // list of single-GPU families. `prioritized` allocation makes the ASG attempt the
    // types in GPU_INSTANCE_PRIORITY order and fall through on capacity shortfalls —
    // so a g5.4xlarge stockout transparently lands on g6/g4dn instead of failing (the
    // problem that forced a manual switch to a CPU instance). On-demand only (no Spot)
    // to keep the attested backend stable.
    const commonAsgProps = {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(10),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
      }),
    };

    this.asg = useMixedInstances
      ? new autoscaling.AutoScalingGroup(this, 'Asg', {
          ...commonAsgProps,
          mixedInstancesPolicy: {
            launchTemplate,
            instancesDistribution: {
              onDemandBaseCapacity: 1,
              onDemandPercentageAboveBaseCapacity: 100,
              onDemandAllocationStrategy: autoscaling.OnDemandAllocationStrategy.PRIORITIZED,
            },
            launchTemplateOverrides: GPU_INSTANCE_PRIORITY.map((t) => ({
              instanceType: new ec2.InstanceType(t),
            })),
          },
        })
      : new autoscaling.AutoScalingGroup(this, 'Asg', {
          ...commonAsgProps,
          launchTemplate,
        });

    cdk.Tags.of(this.asg).add('Project', 'BoltzAttestationDemo');

    // ==================== Attach to NLB ====================
    props.nlbListener.addTargets('AsgTarget', {
      port: this.backendPort,
      targets: [this.asg],
      healthCheck: {
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-AS3',
      reason: 'ASG scaling notifications out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-EC26',
      reason: 'Root volume encryption is defined by the attested kiwi-ng AMI (encrypted erofs + dm-verity); the launch template intentionally does not override the AMI block-device mapping',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'Construct-Annotations::@aws-cdk/aws-autoscaling:desiredCapacitySet',
      reason: 'Desired capacity intentionally set to 1 for single-instance demo',
    });
    const nagRules: Record<string, string> = {};
    nagRules['AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]'] =
      'SSM managed policy required for Session Manager access on the FOA/dev AMI variant';
    nagRules['AwsSolutions-IAM5[Resource::*]'] =
      'ssm resolve and ec2 metadata actions require Resource::* (no resource-level scoping)';
    nagRules['AwsSolutions-IAM5[Action::s3:GetObject*]'] =
      'Instances read model weights / build source from the artifacts bucket';
    nagRules['AwsSolutions-IAM5[Action::s3:GetBucket*]'] =
      'Instances read model weights / build source from the artifacts bucket';
    nagRules['AwsSolutions-IAM5[Action::s3:List*]'] =
      'Instances read model weights / build source from the artifacts bucket';
    nagRules['AwsSolutions-IAM5[Resource::arn:aws:s3:::boltz-models-*]'] =
      'Instances read encrypted model weights from the env-suffixed models bucket';
    nagRules['AwsSolutions-IAM5[Resource::arn:aws:s3:::boltz-models-*/*]'] =
      'Instances read encrypted model weight objects from the models bucket';
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}
