import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface EncryptionProps {
  readonly envName?: string;
}

/**
 * KMS keys for the Boltz application (replaces scripts/setup-kms.sh).
 *
 *  - sequenceKey (alias/boltz-sequence-key): client-side encryption of protein
 *    sequences uploaded by users. The Cognito authenticated role is granted
 *    Encrypt/GenerateDataKey with the `application=boltz-protein-folding`
 *    encryption-context condition (attached in the Auth construct so the grant
 *    can reference the authenticated role).
 *  - modelKey (alias/boltz-model-key): encryption of model weights in the models
 *    bucket (SSE-KMS).
 *
 * PCR-bound decrypt conditions for attestation-gated access are added post-deploy
 * via the KMS Policy Editor in the web UI (unchanged from the script workflow).
 */
export class Encryption extends Construct {
  public readonly sequenceKey: kms.Key;
  public readonly modelKey: kms.Key;

  constructor(scope: Construct, id: string, props: EncryptionProps = {}) {
    super(scope, id);

    const env = props.envName ?? 'prod';

    this.sequenceKey = new kms.Key(this, 'SequenceKey', {
      alias: 'boltz-sequence-key',
      description: `KMS key for Boltz protein sequence encryption (${env})`,
      enableKeyRotation: true,
      // On `cdk destroy`, schedule the key for deletion with the minimum 7-day window
      // (KMS never deletes keys immediately). Aliases are freed right away, so a fresh
      // deploy can recreate alias/boltz-sequence-key without waiting.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    cdk.Tags.of(this.sequenceKey).add('Application', 'boltz-protein-folding');
    cdk.Tags.of(this.sequenceKey).add('Environment', env);
    cdk.Tags.of(this.sequenceKey).add('Purpose', 'sequence-encryption');

    this.modelKey = new kms.Key(this, 'ModelKey', {
      alias: 'boltz-model-key',
      description: `KMS key for Boltz model weights encryption (${env})`,
      enableKeyRotation: true,
      // Schedule for deletion (7-day window) on destroy; alias freed immediately.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    cdk.Tags.of(this.modelKey).add('Application', 'boltz-protein-folding');
    cdk.Tags.of(this.modelKey).add('Environment', env);
    cdk.Tags.of(this.modelKey).add('Purpose', 'model-encryption');
  }
}
