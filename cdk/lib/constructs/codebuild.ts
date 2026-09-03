import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Storage } from './storage';

export interface CodeBuildProps {
  readonly sourceBucket: s3.Bucket;
  readonly amiIdParam: ssm.IStringParameter;
  readonly pcrValuesParam: ssm.IStringParameter;
  /**
   * SSM parameter holding the kiwi build profile ('prod' | 'foa'). CodeBuild
   * reads its value at build start via a PARAMETER_STORE environment variable,
   * so the profile is a build-time configuration flipped with `aws ssm
   * put-parameter` (no source change, no stack redeploy). Seeded to 'prod'
   * (Zero Operator Access) by the Storage construct.
   */
  readonly buildProfileParam: ssm.IStringParameter;
}

/**
 * Minimal EC2 (LINUX_EC2) build image. kiwi-ng builds a full VM disk image and
 * needs loop devices, dm-verity/veritysetup and a real kernel, which are not
 * available in CodeBuild's container sandbox — even in privileged mode. A
 * reserved-capacity EC2 fleet runs the buildspec directly on an EC2 host where
 * those work. CDK's LinuxBuildImage is hardcoded to LINUX_CONTAINER, and the
 * Project L2 requires buildImage.type === fleet.environmentType, so we supply a
 * tiny IBuildImage reporting LINUX_EC2 backed by the AL2023 x86_64 image id.
 */
class LinuxEc2BuildImage implements codebuild.IBuildImage {
  public readonly type = codebuild.EnvironmentType.LINUX_EC2;
  public readonly defaultComputeType = codebuild.ComputeType.LARGE;
  public readonly imagePullPrincipalType = codebuild.ImagePullPrincipalType.CODEBUILD;
  constructor(public readonly imageId: string) {}
  public validate(_env: codebuild.BuildEnvironment): string[] {
    return [];
  }
  public runScriptBuildspec(entrypoint: string): codebuild.BuildSpec {
    return codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: { build: { commands: [entrypoint] } },
    });
  }
}

/**
 * CodeBuild project that builds the NitroTPM-attested AMI with kiwi-ng.
 *
 * This is the "kiwi overlay" build project. It consumes the packaged source
 * (app/ + packaging-kiwi-ng/) and:
 *   1. installs the kiwi-ng toolchain (install-deps.sh),
 *   2. runs packaging-kiwi-ng/scripts/build.sh which prepares the overlay
 *      (bakes app/backend + shared + requirements into /opt/boltz/app) and runs
 *      `kiwi-ng system build` to produce output/*.raw + output/pcr_measurements.json,
 *   3. runs upload-ami.sh which uploads the raw image as an EBS snapshot via
 *      coldsnap and registers a TPM v2.0 / UEFI AMI,
 *   4. emits ami-id.txt + pcr_measurements.json as the CodeDeploy/deploy artifact
 *      and mirrors them to S3.
 *
 * Requires privileged mode (kiwi-ng uses loop devices, veritysetup, dm-verity)
 * and runs on an Amazon Linux 2023 image so `dnf install kiwi-cli ...` works.
 */
export class CodeBuildProject extends Construct {
  public readonly buildProject: codebuild.Project;
  public readonly buildRole: iam.Role;
  public readonly fleet: codebuild.Fleet;

  constructor(scope: Construct, id: string, props: CodeBuildProps) {
    super(scope, id);

    // ==================== CodeBuild Role ====================
    this.buildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // S3 access for source + AMI raw/PCR artifacts
    this.buildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:PutObject',
        's3:DeleteObject',
      ],
      resources: [props.sourceBucket.bucketArn, `${props.sourceBucket.bucketArn}/*`],
    }));

    // EBS Direct APIs (coldsnap) + snapshot/AMI registration
    this.buildRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ebs:StartSnapshot',
        'ebs:PutSnapshotBlock',
        'ebs:CompleteSnapshot',
        'ebs:GetSnapshotBlock',
        'ebs:ListSnapshotBlocks',
        'ec2:CreateSnapshot',
        'ec2:ImportSnapshot',
        'ec2:DescribeSnapshots',
        'ec2:DescribeImportSnapshotTasks',
        'ec2:RegisterImage',
        'ec2:DescribeImages',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));

    // Update the AMI-id + PCR trust-store SSM parameters after a successful build
    props.amiIdParam.grantWrite(this.buildRole);
    props.pcrValuesParam.grantWrite(this.buildRole);

    // Read the build-profile parameter. CodeBuild resolves a PARAMETER_STORE env var
    // at build start using the project's service role, so it needs ssm:GetParameters.
    props.buildProfileParam.grantRead(this.buildRole);

    // ==================== Reserved-capacity EC2 Fleet ====================
    // kiwi-ng cannot build a VM/OEM disk image inside a container. Run the build
    // on a dedicated EC2 fleet (LINUX_EC2). LINUX_EC2 requires a CUSTOM_INSTANCE_TYPE
    // (attribute-based sizing is not supported for EC2 fleets), so pin a concrete
    // x86_64 instance. c7i.4xlarge (16 vCPU / 32 GiB): the newest c-family CodeBuild
    // reserved fleets support (c8i is NOT supported), at a larger size than the previous
    // c5.2xlarge (8 vCPU / 16 GiB) to speed the kiwi build, package installs, and coldsnap
    // upload. Extra disk over the 64 GiB default for the ~40 GiB raw image + intermediates.
    // NOTE: no explicit fleetName. CodeBuild fleets can sit in PENDING_DELETION
    // for up to ~1 hour, so a fixed name would collide with a lingering fleet on
    // the next deploy. Let CloudFormation auto-generate a unique physical name.
    this.fleet = new codebuild.Fleet(this, 'AmiBuilderFleet', {
      baseCapacity: 1,
      environmentType: codebuild.EnvironmentType.LINUX_EC2,
      computeType: codebuild.FleetComputeType.CUSTOM_INSTANCE_TYPE,
      computeConfiguration: {
        instanceType: new ec2.InstanceType('c7i.4xlarge'),
        // kiwi builds a 40 GiB raw image AND the image-root chroot (which installs the
        // NVIDIA driver + torch/boltz — many GiB) AND intermediate copies, all on this
        // disk. 64 GiB overflows ("No space left on device"), so provision headroom.
        disk: cdk.Size.gibibytes(200),
      },
    });

    // ==================== CodeBuild Project ====================
    this.buildProject = new codebuild.Project(this, 'AmiBuilder', {
      projectName: 'boltz-attestation-ami-builder',
      description: 'Build NitroTPM attested Boltz AMI with kiwi-ng and register it',
      environment: {
        // EC2 (non-container) compute via the fleet above. No privileged flag —
        // the buildspec runs directly on the EC2 host, where loop devices and
        // dm-verity work natively.
        buildImage: new LinuxEc2BuildImage('aws/codebuild/amazonlinux-x86_64-standard:5.0'),
        fleet: this.fleet,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          AWS_ACCOUNT_ID: { value: cdk.Stack.of(this).account },
          AMI_ID_PARAM: { value: Storage.AMI_ID_PARAM_NAME },
          PCR_VALUES_PARAM: { value: Storage.PCR_VALUES_PARAM_NAME },
          ARTIFACT_BUCKET: { value: props.sourceBucket.bucketName },
          // Build profile, read from SSM at build start (PARAMETER_STORE): 'prod' =
          // attested Zero Operator Access image (no SSH, no SSM agent, no cloud-init,
          // dm-verity read-only root); 'foa' = Full Operator Access (SSH/SSM) for
          // dev/test only. This is a build-time configuration flipped with
          // `aws ssm put-parameter` (not baked into source). Seeded to 'prod' by Storage.
          BUILD_PROFILE: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: props.buildProfileParam.parameterName,
          },
        },
      },
      role: this.buildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'echo "Installing kiwi-ng build dependencies..."',
              // build.sh / upload-ami.sh call `sudo`; the EC2 fleet build runs as
              // root, so provide a no-op sudo shim if the binary is absent.
              'command -v sudo >/dev/null 2>&1 || (dnf install -y sudo || (printf "#!/bin/sh\\nexec \\"$@\\"\\n" > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo))',
              // Mirror packaging-kiwi-ng/scripts/install-deps.sh
              'dnf install -y kiwi-cli python3-kiwi kiwi-systemdeps-core python3-poetry-core qemu-img veritysetup erofs-utils git jq aws-nitro-tpm-tools || dnf install -y python3-kiwi qemu-img veritysetup erofs-utils git jq',
              // coldsnap (installed below) pulls in AWS SDK crates whose minimum
              // supported Rust version now exceeds the distro `cargo` (rustc 1.92 on
              // AL2023), so `dnf`'s cargo can no longer build it. Install a current
              // rustup toolchain instead, plus the C build deps that coldsnap's
              // crypto crate (aws-lc-sys) needs on a bare AL2023 EC2-fleet host.
              'dnf install -y gcc gcc-c++ make cmake perl nasm || dnf install -y gcc gcc-c++ make cmake perl',
              'echo "Installing current Rust toolchain via rustup..."',
              'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal',
              'source "$HOME/.cargo/env"',
              'rustc --version && cargo --version',
              'echo "Installing coldsnap (EBS direct upload)..."',
              'cargo install --locked coldsnap',
              'export PATH="$HOME/.cargo/bin:$PATH"',
            ],
          },
          pre_build: {
            commands: [
              // CodePipeline extracts source/source.zip (uploaded by
              // scripts/package-and-upload.sh) into $CODEBUILD_SRC_DIR. That zip
              // has app/ and packaging-kiwi-ng/ at its root, so build.sh finds the
              // overlay app source at ../app relative to its own location.
              'echo "Source layout (expect app/ and packaging-kiwi-ng/ at root):"',
              'ls -la',
              'test -d app && test -d packaging-kiwi-ng || { echo "ERROR: expected app/ and packaging-kiwi-ng/ from source.zip"; exit 1; }',
              // Diagnostics: show the disk/mount layout so we can see which
              // filesystem the fleet exposes and where the large disk is mounted.
              'echo "===== DISK LAYOUT ====="; df -h; echo "----- lsblk -----"; lsblk 2>/dev/null || true; echo "PWD=$PWD CODEBUILD_SRC_DIR=$CODEBUILD_SRC_DIR"; echo "======================="',
              'export PATH="$HOME/.cargo/bin:$PATH"',
              'export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}',
            ],
          },
          build: {
            commands: [
              'chmod +x packaging-kiwi-ng/scripts/*.sh',
              // BUILD_PROFILE is resolved from the /boltz-attestation/build-profile SSM
              // parameter (PARAMETER_STORE env var). Default to the secure prod if the
              // parameter is somehow empty; build.sh also defaults to prod.
              ': "${BUILD_PROFILE:=prod}"',
              'echo "Building attested AMI with kiwi-ng (profile: $BUILD_PROFILE from SSM)..."',
              // IMPORTANT: on the CodeBuild EC2 fleet, /tmp (and $CODEBUILD_SRC_DIR
              // under it) is a RAM-backed tmpfs capped at ~7.6 GiB, while / is a
              // 424 GiB nvme volume. kiwi writes a 40 GiB raw image + 20 GiB rootfs,
              // which overflows tmpfs ("No space left on device"). Redirect all
              // scratch + output to a directory on the big root volume.
              'export BUILD_WORK=/build-work',
              // Reserved-capacity EC2 fleets REUSE the host across builds, so a
              // prior run's /build-work persists. kiwi refuses to build over an
              // existing image-root ("KiwiRootDirExists"), so wipe it first.
              'sudo rm -rf "$BUILD_WORK" || rm -rf "$BUILD_WORK"',
              'mkdir -p "$BUILD_WORK/tmp" "$BUILD_WORK/output"',
              'export TMPDIR="$BUILD_WORK/tmp"',   // kiwi honours TMPDIR for scratch
              // build.sh writes the .raw into --output (on the big volume)
              'packaging-kiwi-ng/scripts/build.sh --profile "$BUILD_PROFILE" --output "$BUILD_WORK/output"',
              'echo "Registering AMI (coldsnap upload + register-image)..."',
              // point upload-ami.sh at the raw image on the big volume; capture log
              'RAW_IMAGE=$(ls "$BUILD_WORK"/output/*.raw | head -1)',
              'packaging-kiwi-ng/scripts/upload-ami.sh --region "$AWS_DEFAULT_REGION" --image "$RAW_IMAGE" | tee "$BUILD_WORK/upload-ami.log"',
            ],
          },
          post_build: {
            commands: [
              'echo "Collecting build outputs..."',
              'export PATH="$HOME/.cargo/bin:$PATH"',
              'export BUILD_WORK=/build-work',
              'mkdir -p artifact',
              // Extract the registered AMI id from the upload log (on the big volume)
              'AMI_ID=$(grep -oE "ami-[0-9a-f]+" "$BUILD_WORK/upload-ami.log" | head -1)',
              'test -n "$AMI_ID" || { echo "ERROR: could not determine registered AMI id"; exit 1; }',
              'echo "Registered AMI: $AMI_ID"',
              'echo "$AMI_ID" > artifact/ami-id.txt',
              // PCR measurements: kiwi editbootinstall writes them into the build
              // target-dir ($BUILD_WORK/output). Fall back to the repo output path.
              'cp "$BUILD_WORK/output/pcr_measurements.json" artifact/pcr_measurements.json 2>/dev/null || cp packaging-kiwi-ng/output/pcr_measurements.json artifact/pcr_measurements.json 2>/dev/null || echo "{}" > artifact/pcr_measurements.json',
              // Mirror artifacts to S3 for auditing
              'aws s3 cp artifact/ami-id.txt "s3://$ARTIFACT_BUCKET/ami/ami-id.txt"',
              'aws s3 cp artifact/pcr_measurements.json "s3://$ARTIFACT_BUCKET/ami/pcr_measurements.json"',
              // Note: SSM parameter update + ASG instance refresh happen in the
              // dedicated Deploy stage so rollout is an explicit, auditable step.
              'echo "AMI build complete."',
            ],
          },
        },
        artifacts: {
          'base-directory': 'artifact',
          files: ['**/*'],
          'discard-paths': 'no',
        },
      }),
    });

    // ==================== cdk-nag Acknowledgements ====================
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const buildProjectNode = this.buildProject.node.defaultChild as cdk.CfnResource;
    const buildProjectLogicalId = cdk.Stack.of(this).getLogicalId(buildProjectNode);

    const nagRules: Record<string, string> = {};
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/<${buildProjectLogicalId}>:*]`] =
      'CDK CodeBuild L2 generates log group ARN with :* suffix for log streams';
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:codebuild:${region}:${account}:report-group/<${buildProjectLogicalId}>-*]`] =
      'CDK CodeBuild L2 generates report group ARN with -* suffix for report names';
    nagRules['AwsSolutions-IAM5[Resource::*]'] =
      'coldsnap EBS-direct APIs and ec2 RegisterImage/CreateSnapshot/DescribeImages require Resource::* (no resource-level scoping)';
    for (const a of ['s3:Abort*', 's3:DeleteObject*', 's3:GetBucket*', 's3:GetObject*', 's3:List*', 'kms:GenerateDataKey*', 'kms:ReEncrypt*']) {
      nagRules[`AwsSolutions-IAM5[Action::${a}]`] =
        'CDK Pipeline L2 grants wildcard S3/KMS actions for artifact management';
    }
    // Build runs on a reserved-capacity EC2 fleet (not a privileged container),
    // so AwsSolutions-CB3 (privileged mode) does not apply here.
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-CB4',
      reason: 'CodeBuild artifact encryption with a customer-managed key out of scope for sample app',
    });
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}
