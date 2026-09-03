import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DataStorageProps {
  readonly envName?: string;
  /**
   * Allowed CORS origin for the sequences bucket (the Amplify frontend URL).
   * localhost dev origins are always included.
   */
  readonly frontendUrl?: string;
}

/**
 * Application data buckets (replaces scripts/setup-s3.sh).
 *
 *  - sequencesBucket (boltz-sequences-<env>): user-uploaded, client-side-encrypted
 *    protein sequences. CORS enabled for the frontend; SSE-S3 at rest (client-side
 *    KMS encryption provides the attestation-gated protection). Public access blocked.
 *  - modelsBucket (boltz-models-<env>): model weights, SSE-KMS with the model key,
 *    bucket keys enabled. Public access blocked.
 */
export class DataStorage extends Construct {
  public readonly sequencesBucket: s3.Bucket;
  public readonly modelsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStorageProps) {
    super(scope, id);

    const env = props.envName ?? 'prod';
    const origins = [
      ...(props.frontendUrl ? [props.frontendUrl] : []),
      'http://localhost:5173',
      'http://localhost:3000',
    ];

    // ==================== Sequences bucket ====================
    // No explicit bucketName: let CDK auto-generate a globally-unique name (random
    // suffix) so destroy/redeploy never collides on a fixed name. The frontend learns
    // the actual name via the VITE_SEQUENCES_BUCKET output; IAM grants reference the
    // bucket ARN, not a name prefix.
    this.sequencesBucket = new s3.Bucket(this, 'SequencesBucket', {
      // Client-side KMS encryption is applied by the frontend; SSE-S3 protects at rest.
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: origins,
          // The browser JS SDK can only read x-amz-meta-* response headers that CORS
          // explicitly exposes. The frontend reads the KMS encryption context (and
          // name/length) it stored on the encrypted sequence so it can pass the EXACT
          // same context to the backend at decrypt time — without these exposed, the
          // SDK returns Metadata:{}, the context is lost, and KMS decrypt fails with
          // InvalidCiphertextException. (The CLI is unaffected; CORS is browser-only.)
          exposedHeaders: [
            'ETag',
            'x-amz-meta-encryption-context',
            'x-amz-meta-name',
            'x-amz-meta-length',
            'x-amz-meta-kms-key-id',
            'x-amz-meta-encrypted',
          ],
          maxAge: 3000,
        },
      ],
      // Sample app: destroy on `cdk destroy` and empty the bucket first so teardown is
      // clean (autoDeleteObjects adds a Lambda that purges objects before delete).
      // NOTE: this means a stack delete DELETES the encrypted sequences.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    cdk.Tags.of(this.sequencesBucket).add('Application', 'boltz-protein-folding');
    cdk.Tags.of(this.sequencesBucket).add('Environment', env);
    cdk.Tags.of(this.sequencesBucket).add('Purpose', 'encrypted-sequences');

    // ==================== Models bucket ====================
    // At-rest encryption uses the S3-managed key (SSE-S3), NOT the model CMK. The
    // model CMK (alias/boltz-model-key) is reserved EXCLUSIVELY for the envelope
    // encryption of the weights, whose decrypt is attestation-gated. Keeping S3's
    // at-rest encryption off the CMK means the CMK is only ever used by the
    // attested-decrypt path — so an explicit "deny decrypt unless PCRs match" on the
    // CMK cannot break S3 object reads. The objects are already envelope-encrypted, so
    // SSE-S3 is just defense-in-depth on already-protected bytes.
    // Auto-generated name (no fixed bucketName) — same rationale as the sequences
    // bucket. The producer workflow gets the real name via CDK ref and writes the full
    // s3:// path to /boltz/models/latest, so nothing depends on a predictable name.
    this.modelsBucket = new s3.Bucket(this, 'ModelsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Destroy + auto-empty on teardown (deletes encrypted model weights).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    cdk.Tags.of(this.modelsBucket).add('Application', 'boltz-protein-folding');
    cdk.Tags.of(this.modelsBucket).add('Environment', env);
    cdk.Tags.of(this.modelsBucket).add('Purpose', 'model-weights');

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'S3 access logging out of scope for sample app',
    });
  }
}
