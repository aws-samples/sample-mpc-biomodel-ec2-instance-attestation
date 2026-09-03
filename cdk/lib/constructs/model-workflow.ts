import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ModelWorkflowProps {
  readonly envName?: string;
  /** Models bucket the workflow uploads encrypted weights to. */
  readonly modelsBucket: s3.IBucket;
  /** KMS key used to envelope-encrypt model weights (alias/boltz-model-key). */
  readonly modelKey: kms.IKey;
  /** Event bus the workflow emits "Model Available" / progress events to. */
  readonly eventBus: events.IEventBus;
}

/**
 * Model update workflow — real download → hash → envelope-encrypt → upload.
 *
 * The Boltz-1 weights are ~4.6 GB, far larger than a Lambda can handle (15-min
 * cap, limited /tmp) and larger than KMS direct Encrypt (4 KB). So the heavy work
 * runs in a CodeBuild project (no time cap, large disk, cloud-side pip install of
 * huggingface_hub + cryptography — nothing installed locally). A Step Function
 * still orchestrates it (StartBuild.sync) and EventBridge still fires the
 * "Model Available" event, matching the original design and the frontend contract.
 *
 * Progress is written to SSM /boltz/models/progress/<version_id> as JSON so the
 * frontend can poll it (download → encrypt → upload → complete), in addition to
 * EventBridge progress events on the boltz-events bus.
 *
 * Encryption: KMS GenerateDataKey (alias/boltz-model-key, encryption context
 * application=boltz-protein-folding) → streaming AES-256-GCM of each weight file
 * (chunked, so files >2 GiB and low memory are fine). Each object is stored as:
 *   [4-byte big-endian wrapped-key-len][wrapped data key][12-byte nonce]
 *   [ciphertext...][16-byte GCM tag]
 * at s3://boltz-models-prod/weights/<version_id>/<file>.enc. To decrypt: read the
 * wrapped key, kms.Decrypt it (same key + encryption context) → data key; read the
 * nonce; the last 16 bytes are the GCM tag; AES-256-GCM-decrypt the middle.
 *
 * The SSM /boltz/models/latest `hash` is the SHA-384 aggregate the attested
 * instance computes for PCR16 (see app/backend/services/attestation.py
 * compute_boltz_model_hash): sha384( sha384_hex(boltz1_conf.ckpt) +
 * sha384_hex(boltz1.ckpt) + sha384_hex(ccd.pkl) ), hex digests concatenated as
 * bytes, in that exact order — so the producer's advertised hash matches the
 * consumer's measurement.
 */
export class ModelWorkflow extends Construct {
  public readonly builder: codebuild.Project;
  public readonly stateMachine: sfn.StateMachine;
  public readonly latestParam: ssm.StringParameter;

  /** File order MUST match attestation.compute_boltz_model_hash for PCR16 parity. */
  public static readonly WEIGHT_FILES = ['boltz1_conf.ckpt', 'boltz1.ckpt', 'ccd.pkl'];

  constructor(scope: Construct, id: string, props: ModelWorkflowProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // ==================== SSM latest-version pointer ====================
    this.latestParam = new ssm.StringParameter(this, 'LatestModel', {
      parameterName: '/boltz/models/latest',
      stringValue: JSON.stringify({ version: 'v0', s3_path: '', hash: '', created_at: '' }),
      description: 'Pointer to the latest Boltz model version',
    });

    // ==================== CodeBuild project (real download/encrypt/upload) ====
    // The worker script is materialised from base64 at build start, so the project
    // is fully self-contained (no separate source repo). REPO / MODEL_VERSION are
    // overridden per Step Function execution; VERSION_ID is generated in-build.
    this.builder = new codebuild.Project(this, 'ModelBuilder', {
      projectName: 'boltz-model-downloader',
      description: 'Download Boltz weights from HuggingFace, envelope-encrypt with KMS, upload to S3',
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
        computeType: codebuild.ComputeType.LARGE, // headroom for the ~4.6 GB weights
        environmentVariables: {
          MODELS_BUCKET: { value: props.modelsBucket.bucketName },
          MODEL_KEY_ID: { value: props.modelKey.keyArn },
          EVENT_BUS_NAME: { value: props.eventBus.eventBusName },
          REPO: { value: 'boltz-community/boltz-1' },
          MODEL_VERSION: { value: 'main' },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'echo "Installing HuggingFace + crypto deps (cloud-side, nothing local)..."',
              'python3 -m pip install --quiet --upgrade pip',
              'python3 -m pip install --quiet "huggingface_hub>=0.23" cryptography boto3',
              'mkdir -p packaging-model',
              // Materialise the worker script from a compile-time base64 literal
              // (Node Buffer at synth — NOT cdk.Fn.base64, which is a runtime CFN
              // intrinsic that would not render as a literal here).
              `echo ${Buffer.from(MODEL_ENCRYPT_SCRIPT, 'utf-8').toString('base64')} | base64 -d > packaging-model/encrypt_and_upload.py`,
            ],
          },
          build: {
            commands: [
              'export VERSION_ID="v$(date -u +%Y%m%d%H%M%S)"',
              'echo "Downloading + encrypting Boltz model: ${REPO}@${MODEL_VERSION} -> ${VERSION_ID}"',
              'python3 packaging-model/encrypt_and_upload.py',
            ],
          },
        },
      }),
    });

    // Grant the build role S3 write, KMS encrypt (with context), SSM progress writes, events
    this.builder.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListBucket', 's3:GetObject'],
      resources: [props.modelsBucket.bucketArn, `${props.modelsBucket.bucketArn}/*`],
    }));
    // (a) Envelope-encryption data key for OUR blob — scoped by the app encryption
    // context so it matches what the backend decrypt will pass.
    this.builder.addToRolePolicy(new iam.PolicyStatement({
      sid: 'EnvelopeDataKey',
      effect: iam.Effect.ALLOW,
      actions: ['kms:GenerateDataKey', 'kms:DescribeKey'],
      resources: [props.modelKey.keyArn],
      conditions: {
        StringEquals: { 'kms:EncryptionContext:application': 'boltz-protein-folding' },
      },
    }));
    // NOTE: The models bucket is now SSE-S3 (S3-managed key), NOT this CMK — so there
    // is no unconditioned S3 SSE-KMS GenerateDataKey/Decrypt grant here anymore. The
    // model CMK is used ONLY for the attestation-gated envelope (produce = GenerateDataKey
    // above; consume = attested Decrypt on the instance). Keeping the CMK single-purpose
    // is what lets the explicit "deny decrypt unless PCRs match" on it be safe.
    this.builder.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/boltz/*`],
    }));
    props.eventBus.grantPutEventsTo(this.builder.grantPrincipal);

    // ==================== Step Function ====================
    // Run the CodeBuild job synchronously (RUN_JOB / .sync), overriding REPO +
    // MODEL_VERSION from the execution input. The build reports progress to SSM +
    // EventBridge and, on success, updates /boltz/models/latest.
    const runBuild = new tasks.CodeBuildStartBuild(this, 'DownloadEncryptUpload', {
      project: this.builder,
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        REPO: { value: sfn.JsonPath.stringAt('$.repo') },
        MODEL_VERSION: { value: sfn.JsonPath.stringAt('$.version') },
      },
      resultPath: '$.build',
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: 'boltz-model-update-workflow',
      definitionBody: sfn.DefinitionBody.fromChainable(runBuild),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
      comment: 'Boltz Model Update Workflow (download -> encrypt -> upload via CodeBuild)',
    });

    // ==================== cdk-nag Acknowledgements ====================
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SF1',
      reason: 'Step Function CloudWatch logging out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-SF2',
      reason: 'Step Function X-Ray tracing out of scope for sample app',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'AwsSolutions-CB4',
      reason: 'CodeBuild artifact encryption with a CMK out of scope for sample app',
    });
    const builderLogicalId = cdk.Stack.of(this).getLogicalId(
      this.builder.node.defaultChild as cdk.CfnResource
    );
    const modelsBucketLogicalId = cdk.Stack.of(this).getLogicalId(
      props.modelsBucket.node.defaultChild as cdk.CfnResource
    );
    const nagRules: Record<string, string> = {};
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/<${builderLogicalId}>:*]`] =
      'CDK CodeBuild L2 generates a log group ARN with :* suffix';
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:codebuild:${region}:${account}:report-group/<${builderLogicalId}>-*]`] =
      'CDK CodeBuild L2 generates a report group ARN with -* suffix';
    nagRules[`AwsSolutions-IAM5[Resource::arn:aws:ssm:${region}:${account}:parameter/boltz/*]`] =
      'Model builder writes progress + version pointers under /boltz/*';
    nagRules[`AwsSolutions-IAM5[Resource::<${modelsBucketLogicalId}.Arn>/*]`] =
      'Model builder writes encrypted weight objects to the models bucket';
    nagRules['AwsSolutions-IAM5[Resource::*]'] =
      'Step Functions RUN_JOB integration + CloudWatch Events for CodeBuild require Resource::*';
    for (const a of ['s3:GetObject*', 's3:List*', 's3:Abort*']) {
      nagRules[`AwsSolutions-IAM5[Action::${a}]`] = 'S3 access for the model builder';
    }
    cdk.Stack.of(this).node.addMetadata('aws:cdk:acknowledged-rules', nagRules);
  }
}

/**
 * Worker script (runs in CodeBuild). Reports progress to SSM + EventBridge at each
 * stage, downloads the weight files from HuggingFace, envelope-encrypts each with
 * the KMS model key, uploads to s3://<bucket>/weights/<version_id>/<file>.enc, and
 * writes the SHA-384 aggregate (PCR16-compatible) into /boltz/models/latest.
 */
const MODEL_ENCRYPT_SCRIPT = String.raw`
import os, json, struct, hashlib
from datetime import datetime, timezone
import boto3
from huggingface_hub import hf_hub_download, HfApi
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

REGION = os.environ["AWS_DEFAULT_REGION"]
BUCKET = os.environ["MODELS_BUCKET"]
KEY_ID = os.environ["MODEL_KEY_ID"]
BUS = os.environ["EVENT_BUS_NAME"]
REPO = os.environ.get("REPO", "boltz-community/boltz-1")
MODEL_VERSION = os.environ.get("MODEL_VERSION", "main")
VERSION_ID = os.environ["VERSION_ID"]

# MUST match app/backend/services/attestation.py compute_boltz_model_hash order.
WEIGHT_FILES = ["boltz1_conf.ckpt", "boltz1.ckpt", "ccd.pkl"]
ENC_CONTEXT = {"application": "boltz-protein-folding"}

ssm = boto3.client("ssm", region_name=REGION)
kms = boto3.client("kms", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)
events = boto3.client("events", region_name=REGION)

def progress(stage, pct, message, extra=None):
    payload = {"version_id": VERSION_ID, "stage": stage, "percent": pct,
               "message": message, "updated_at": datetime.now(timezone.utc).isoformat()}
    if extra:
        payload.update(extra)
    ssm.put_parameter(Name=f"/boltz/models/progress/{VERSION_ID}",
                      Value=json.dumps(payload), Type="String", Overwrite=True)
    ssm.put_parameter(Name="/boltz/models/progress/latest",
                      Value=json.dumps(payload), Type="String", Overwrite=True)
    try:
        events.put_events(Entries=[{
            "EventBusName": BUS, "Source": "boltz.model-workflow",
            "DetailType": "Model Progress", "Detail": json.dumps(payload)}])
    except Exception as e:
        print("event emit failed (non-fatal):", e)
    print(f"[progress] {stage} {pct}% {message}")

def sha384_file(path):
    h = hashlib.sha384()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()

CHUNK = 64 * 1024 * 1024  # 64 MiB streaming chunks

def envelope_encrypt_upload(local_path, key, fname=None, idx=0, total=0, pct_lo=0, pct_hi=0):
    # KMS data key wrapped by the SAME model KMS key (alias/boltz-model-key) that
    # decryption will later unwrap it with; encryption-context is IAM-enforced.
    dk = kms.generate_data_key(KeyId=KEY_ID, KeySpec="AES_256", EncryptionContext=ENC_CONTEXT)
    plaintext_key, wrapped_key = dk["Plaintext"], dk["CiphertextBlob"]
    nonce = os.urandom(12)
    # Stream AES-256-GCM via Cipher (one-shot AESGCM caps at 2**31-1 bytes, which
    # the ~2.4 GB boltz1_conf.ckpt exceeds). Write encrypted output to a temp file,
    # then multipart-upload it — never holding the whole file in memory.
    encryptor = Cipher(algorithms.AES(plaintext_key), modes.GCM(nonce)).encryptor()
    enc_path = local_path + ".enc"
    # blob layout: [4B wrapped-key-len][wrapped key][12B nonce][ciphertext][16B GCM tag]
    with open(local_path, "rb") as fin, open(enc_path, "wb") as fout:
        fout.write(struct.pack(">I", len(wrapped_key)))
        fout.write(wrapped_key)
        fout.write(nonce)
        for chunk in iter(lambda: fin.read(CHUNK), b""):
            fout.write(encryptor.update(chunk))
        fout.write(encryptor.finalize())
        fout.write(encryptor.tag)  # 16-byte GCM auth tag, appended last
    del plaintext_key
    # Byte-level upload progress: boto3 fires Callback per transferred chunk (and from
    # multiple threads for multipart), so accumulate under a lock and report only when the
    # overall integer percent (mapped into this file's [pct_lo, pct_hi] band) changes, which
    # bounds SSM writes. upload_file streams via multipart automatically for large files.
    import threading
    enc_size = os.path.getsize(enc_path)
    _lock = threading.Lock()
    _seen = [0]
    _last = [-1]
    _MB = 1024 * 1024
    def _upload_cb(n_bytes):
        if not enc_size:
            return
        with _lock:
            _seen[0] += n_bytes
            frac = min(1.0, _seen[0] / enc_size)
            pct = int(pct_lo + (pct_hi - pct_lo) * frac)
            if pct != _last[0]:
                _last[0] = pct
                progress("uploading", pct,
                         f"Uploading {fname} ({idx}/{total}) - {_seen[0]//_MB}/{enc_size//_MB} MB")
    s3.upload_file(enc_path, BUCKET, key, Callback=_upload_cb,
                   ExtraArgs={"Metadata": {"application": "boltz-protein-folding",
                                           "encryption": "kms-envelope-aesgcm-stream"}})
    os.remove(enc_path)

def _resolve_source_commit():
    # Cheap metadata-only call: resolve the immutable commit SHA the revision points
    # to (e.g. "main" -> a specific commit). Lets us detect whether HF changed without
    # downloading anything.
    try:
        info = HfApi().repo_info(repo_id=REPO, revision=MODEL_VERSION)
        return getattr(info, "sha", None)
    except Exception as e:
        print("could not resolve HF commit (will not skip):", e)
        return None

def _s3_objects_present(version_id):
    # Confirm every expected encrypted object still exists for that version.
    for fname in WEIGHT_FILES:
        try:
            s3.head_object(Bucket=BUCKET, Key=f"weights/{version_id}/{fname}.enc")
        except Exception:
            return False
    return True

def _load_latest():
    try:
        v = ssm.get_parameter(Name="/boltz/models/latest")["Parameter"]["Value"]
        return json.loads(v)
    except Exception:
        return None

def main():
    workdir = "/tmp/boltz-weights"
    os.makedirs(workdir, exist_ok=True)
    progress("starting", 0, f"Starting model update {VERSION_ID} from {REPO}@{MODEL_VERSION}")

    # ---- Skip if S3 is already current --------------------------------------------
    # If the HF source commit matches what the last successful run built, and those
    # encrypted objects are still in S3, re-downloading + re-encrypting 10 GB is pure
    # waste. Short-circuit and point callers at the existing version.
    source_commit = _resolve_source_commit()
    prev = _load_latest()
    if source_commit and prev and prev.get("source_commit") == source_commit \
            and prev.get("version") and _s3_objects_present(prev["version"]):
        progress("complete", 100,
                 f"Source unchanged ({REPO}@{MODEL_VERSION} = {source_commit[:12]}); "
                 f"S3 already current at {prev['version']} — skipped download/encrypt.",
                 {"s3_path": prev.get("s3_path"), "hash": prev.get("hash"),
                  "skipped": True, "version": prev.get("version")})
        events.put_events(Entries=[{
            "EventBusName": BUS, "Source": "boltz.model-workflow", "DetailType": "Model Available",
            "Detail": json.dumps({"type": "model-available", "title": "Model Already Current",
                                  "message": f"No change in {REPO}@{MODEL_VERSION}; using existing {prev.get('version')}.",
                                  "version_id": prev.get("version"), "s3_path": prev.get("s3_path"),
                                  "hash": prev.get("hash"), "skipped": True, "action_required": False})}])
        print("SKIP (unchanged)", json.dumps(prev))
        return

    per_file_hex = []
    n = len(WEIGHT_FILES)
    for i, fname in enumerate(WEIGHT_FILES):
        step = 90.0 / n
        base = 5 + step * i
        progress("downloading", round(base), f"Downloading {fname} ({i+1}/{n})")
        local = hf_hub_download(repo_id=REPO, filename=fname, revision=MODEL_VERSION, local_dir=workdir)
        per_file_hex.append(sha384_file(local))
        progress("encrypting", round(base + 0.4 * step), f"Encrypting {fname} ({i+1}/{n})")
        # Upload reports byte-level progress across [base+0.5*step, base+step].
        envelope_encrypt_upload(local, f"weights/{VERSION_ID}/{fname}.enc",
                                fname=fname, idx=i + 1, total=n,
                                pct_lo=base + 0.5 * step, pct_hi=base + step)
        os.remove(local)  # free /tmp between files

    # Aggregate hash = sha384 over the concatenated per-file hex digests (as bytes),
    # in WEIGHT_FILES order — matches compute_boltz_model_hash for PCR16 parity.
    agg = hashlib.sha384()
    for hx in per_file_hex:
        agg.update(hx.encode())
    model_hash = agg.hexdigest()

    s3_path = f"s3://{BUCKET}/weights/{VERSION_ID}/"
    latest = {"version": VERSION_ID, "s3_path": s3_path, "hash": model_hash,
              "source_commit": source_commit,
              "created_at": datetime.now(timezone.utc).isoformat()}
    ssm.put_parameter(Name="/boltz/models/latest", Value=json.dumps(latest), Type="String", Overwrite=True)
    ssm.put_parameter(Name=f"/boltz/models/{VERSION_ID}", Value=json.dumps(latest), Type="String", Overwrite=True)

    progress("complete", 100, f"Model {VERSION_ID} ready", {"s3_path": s3_path, "hash": model_hash})
    events.put_events(Entries=[{
        "EventBusName": BUS, "Source": "boltz.model-workflow", "DetailType": "Model Available",
        "Detail": json.dumps({"type": "model-available", "title": "New Model Weights Available",
                              "message": f"Model {VERSION_ID} is ready. Select deployment strategy.",
                              "version_id": VERSION_ID, "s3_path": s3_path, "hash": model_hash,
                              "action_required": True})}])
    print("DONE", json.dumps(latest))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            progress("failed", 0, f"Model update failed: {e}")
        finally:
            raise
`;
