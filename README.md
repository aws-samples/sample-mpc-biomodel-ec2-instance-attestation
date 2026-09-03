# Sample MPC Biomodel EC2 Instance Attestation

A secure protein structure prediction service using the [Boltz](https://github.com/jwohlwend/boltz) model with hardware-based attestation on AWS EC2 instances with NitroTPM.

## Overview

This project demonstrates how to deploy a machine learning model (Boltz for protein folding) in a trusted execution environment with cryptographic attestation. The attestation proves to remote parties that:

1. **Code integrity**: the application code has not been modified (established by the PCR measurements).
2. **Model authenticity**: the model weights are genuine and unmodified (established by PCR16).
3. **Hardware trust**: the computation runs on genuine AWS Nitro hardware.
4. **Attestation-gated decryption**: model weights and input sequences can be decrypted only
   inside an instance that presents the expected NitroTPM PCRs. This is enforced by an explicit
   Deny on the KMS key, which denies `kms:Decrypt` when the PCRs are missing or incorrect.
   Because an explicit Deny overrides every Allow, decryption is a hard requirement rather than
   a best-effort grant.

## What this predicts (and what it does not)

This sample performs one specific machine learning task, defined precisely below.

- **Supported**: given a single protein sequence, the Boltz-1 model predicts that protein's
  three-dimensional folded structure, that is, the spatial coordinates of each amino acid. The
  backend returns a PDB file together with a per-residue structure-confidence score (pLDDT, on a
  scale of 0 to 100). The 3D viewer renders the single folded chain, colored from the chain
  start (blue) to the chain end (red) to trace the backbone.
- **Not supported**: the sample does not perform molecular docking, does not model
  protein-protein, protein-DNA, or protein-ligand complexes, and does not predict binding
  affinity. Each prediction processes exactly one molecule, so no interaction between molecules
  is computed. The pLDDT score measures fold quality only; it is neither a binding affinity nor
  an experimental measurement. Modeling multi-entity complexes or predicting affinity would
  require multi-chain inputs and a Boltz-2-class model, which is outside the scope of this
  sample.

## Architecture

The UI is hosted on AWS Amplify and reaches the attested backend only through API
Gateway + VPC Link + an internal NLB; the EC2 instance is never publicly exposed.

```
   Browser
      |
      v
  AWS Amplify (React/Vite UI)  <--- Cognito (User Pool + Identity Pool):
      |                              JWT for the API, SDK creds for S3/KMS/SSM
      | HTTPS (Cognito JWT)
      v
  API Gateway (HTTP API, Cognito JWT authorizer)
      |
      | VPC Link
      v
  Internal Network Load Balancer  --:8000-->  Auto Scaling Group
                                              (attested EC2, kiwi-ng AMI, 1x GPU)
                                                |
                                                v
                                          FastAPI backend
                                            |            |
                                            v            v
                                     Boltz (GPU fold)   Attestation svc (NitroTPM)
                                            |            |
                                            v            v
                                     Model cache        NitroTPM (/dev/tpmrm0)
                                     (decrypted)

  Encrypted weights/sequences <---> S3 (SSE-KMS)
  Attestation-gated decrypt    <---> AWS KMS (PCR-conditioned key policy)

  Build/deploy: source.zip -> S3 -> CodePipeline (CodeBuild kiwi-ng AMI build)
                -> Step Functions (SSM AMI swap + ASG instance refresh)
```

## Features

- **Protein Structure Prediction**: Uses the Boltz-1 model to fold a single input protein sequence into a 3D structure (single-sequence mode on the offline instance; no docking/complexes/affinity)
- **Hardware Attestation**: Cryptographic proof of execution environment via NitroTPM
- **PCR Measurements**: Platform Configuration Registers track boot and application state
- **Model Hash in PCR16**: ML model weights are hashed and extended into TPM for verification
- **AWS KMS Integration**: Seal sensitive data to specific PCR values
- **Progress Tracking**: long-running predictions and model updates are tracked by polling status over HTTPS (Step Functions execution state and the backend's job/reload-status endpoints); there is no WebSocket
- **3D Visualization**: Interactive molecular viewer using 3Dmol.js

## Project Structure

```
sample-mpc-biomodel-ec2-instance-attestation/
├── app/                          # Main application code
│   ├── backend/                  # FastAPI backend service
│   │   ├── api/                  # API routes and models
│   │   └── services/             # Business logic
│   │       ├── attestation.py    # TPM attestation service
│   │       ├── boltz_service.py  # ML model wrapper
│   │       └── ...
│   ├── frontend/                 # React/Vite UI (hosted on AWS Amplify)
│   └── requirements.txt          # Python dependencies
├── packaging-kiwi-ng/            # Kiwi image builder config (prod + foa profiles)
│   ├── kiwi/                     # Kiwi configuration
│   └── scripts/                  # Build scripts
├── cdk/                          # CDK infra (pipeline, ASG, Amplify, etc.)
└── docs/                         # Documentation
```

## Infrastructure Setup

All AWS infrastructure is defined as **AWS CDK** (TypeScript) under [`cdk/`](cdk/):
Cognito, IAM, KMS, S3, VPC, API Gateway with VPC Link and an internal NLB, the EC2 Auto
Scaling Group, the AMI build and deploy pipeline, and Amplify hosting. The earlier
per-resource `setup-*.sh` scripts have been replaced by CDK.

The only helper scripts that remain are:

| Script | Purpose |
|--------|---------|
| [`scripts/package-and-upload.sh`](scripts/package-and-upload.sh) | Zip `app/` + `packaging-kiwi-ng/` and upload to S3, triggering the AMI build pipeline (build attested AMI → roll ASG) |
| [`cdk/scripts/deploy-frontend.sh`](cdk/scripts/deploy-frontend.sh) | Build the React/Vite UI and deploy it to the CDK-created Amplify app |
| [`cdk/scripts/ec2-user-data.sh`](cdk/scripts/ec2-user-data.sh) | FOA-variant boot health confirmation (the prod attested AMI ignores user-data) |

### Deploy

```bash
cd cdk
npm ci

# Option 1: everything in one stack
npx cdk deploy BoltzAttestationStack

# Option 2: separate backend and frontend stacks
npx cdk deploy BoltzAttestationBackend BoltzAttestationFrontend

# Then build + roll the attested AMI (prod / Zero Operator Access by default) and deploy the UI:
cd ..
./scripts/package-and-upload.sh
./cdk/scripts/deploy-frontend.sh BoltzAttestationStack <aws-profile>
```

By default the pipeline builds the **`prod`** profile: the attested Zero Operator
Access (ZOA) image with no SSH, no SSM agent, no cloud-init, and a dm-verity
read-only root. This is set by `BUILD_PROFILE` in
[`cdk/lib/constructs/codebuild.ts`](cdk/lib/constructs/codebuild.ts). For a
debuggable image with SSH/SSM access, use the `foa` profile instead
(see [Dev/Test Environment](#devtest-environment-foa-profile)).

Cognito / API / KMS / bucket identifiers are emitted as CloudFormation **stack
outputs** (and written to `cdk/cdk-outputs.json` when deployed with `--outputs-file`);
`deploy-frontend.sh` reads them to inject the frontend's `VITE_*` config. See
[`cdk/bin/cdk.ts`](cdk/bin/cdk.ts) for all deployment options (including the
existing-EC2 frontend dev mode).

### Post-deploy: create a test user

The Cognito user pool has self-signup enabled (email sign-in), so you can register from
the login page. To create a ready-to-use test user non-interactively instead, use the
`UserPoolId` stack output:

```bash
POOL="<UserPoolId stack output>"          # e.g. us-east-2_xxxxxxxxx
EMAIL="boltz-tester@example.com"
PASS='BoltzTest!2026'                      # min 8, upper + lower + digit + symbol

aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS
# Set a permanent password so there is no forced reset on first login:
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$EMAIL" \
  --password "$PASS" --permanent
```

Then sign in at the `AmplifyAppUrl` stack output. One user works for both personas
(biologist and biophysicist are chosen in the UI, not via Cognito groups).

### Backend CORS (handled automatically)

The backend defaults to a **closed** CORS policy: with no origin configured it rejects
cross-origin browser requests. On a normal `cdk deploy` this is now resolved
**automatically** and needs no manual step: the Amplify app is created by the same stack,
so its origin is known at deploy time, and CDK writes it to the SSM parameter
`/boltz-attestation/cors-origins`. At boot, `boltz-config.service` reads that parameter
over the instance's IAM role and writes `CORS_ORIGINS` into `/etc/boltz/environment`
before `boltz-backend` starts. This works under Zero Operator Access and survives ASG
instance replacement (see below for how the parameter is consumed).

The manual override below is only needed to **debug** on an **FOA** image, or to point the
backend at a different origin out of band. Set `CORS_ORIGINS` (comma-separated allowlist of
exact origins) in `/etc/boltz/environment` and restart the service. On the **FOA**
(debuggable) image you can do this over SSM without SSH:

```bash
AMPLIFY_URL="https://main.<app-id>.amplifyapp.com"   # from the AmplifyAppUrl stack output
INSTANCE_ID="<the in-service ASG instance id>"

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters commands="[\
\"mkdir -p /etc/boltz\",\
\"echo CORS_ORIGINS=$AMPLIFY_URL >> /etc/boltz/environment\",\
\"systemctl restart boltz-backend\"]"
```

Verify the preflight now succeeds (expect `200`, not `400`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
  "<ApiEndpoint>/api/v1/attestation" \
  -H "Origin: $AMPLIFY_URL" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization"
```

The SSM `send-command` above works only on the **FOA** image, which runs the SSM agent.
The `prod` / Zero Operator Access (ZOA) image has no SSH or SSM agent and a dm-verity
read-only root, so no operator can write this file at runtime. For ZOA, the origin must
reach the instance through a path the instance itself can use with its own IAM role:

- **Recommended (the approach this sample uses): read the origin from SSM Parameter Store at
  boot.** The Amplify origin is published to the SSM parameter `/boltz-attestation/cors-origins`,
  which CDK sets from the `AmplifyAppUrl` output; the `main.<app-id>.amplifyapp.com` domain is
  fixed as soon as the Amplify app exists. A oneshot unit ordered before `boltz-backend`
  (`boltz-config.service`) fetches that parameter via the instance role over the SSM VPC
  endpoint and writes `CORS_ORIGINS` into `/etc/boltz/environment` on the writable overlay
  before the service starts. This preserves Zero Operator Access (the instance fetches its own
  configuration, with no operator shell), survives ASG instance replacement, and does not
  affect attestation, because the overlay write is not part of the verity-measured base or
  PCR16. The instance already reads other SSM parameters this way (the AMI id and the PCR
  trust store).
- **Alternative: bake the origin at AMI build time.** The Amplify URL is known after
  `cdk deploy` and before `package-and-upload.sh` builds the image, so the pipeline can write
  `CORS_ORIGINS` into the overlay's `/etc/boltz/environment` during the build. This is simpler,
  but the origin is then fixed per AMI and changing it requires a rebuild.

`/etc/boltz/environment` lives on the instance's writable overlay, so the FOA `send-command`
method must be re-applied whenever the ASG replaces the instance; the two ZOA options above
avoid that because the value is re-supplied on every boot or baked into the image.

## Quick Start

### Prerequisites

- An AWS account with credentials configured, and permissions to deploy the stack
  (CloudFormation, EC2/ASG, API Gateway, Cognito, KMS, S3, CodePipeline/CodeBuild,
  Step Functions, Amplify).
- Node.js + AWS CDK v2 (`cdk/` uses aws-cdk-lib 2.260.0) and the AWS CLI.
- Deploys to a region offering NitroTPM and single-GPU instances
  (g7/g6e/g6/g5 families; see the ASG mixed-instances policy in
  [`cdk/lib/constructs/compute.ts`](cdk/lib/constructs/compute.ts)). The default region
  in this repo is `us-east-2`.

Everything else (the attested AMI, its GPU drivers, TPM tooling, Python runtime, and
the Boltz backend) is produced by the kiwi-ng AMI build; you do not hand-provision an
instance.

### Dev/Test Environment (FOA profile)

For development and testing, build the AMI with the **`foa` (Full Operator Access)**
profile instead of `prod`. It uses the same attested-AMI build path as production, with
SSH, the SSM Agent, and cloud-init additionally enabled so you can reach the instance to
debug. What you test is therefore the real image rather than a divergent, ad-hoc setup.

```bash
# Point the build pipeline at the FOA profile, then deploy + let the pipeline build/roll.
# (cdk/lib/constructs/codebuild.ts -> BUILD_PROFILE = 'foa')
cd cdk && npx cdk deploy BoltzAttestationStack --require-approval never
./scripts/package-and-upload.sh          # triggers the pipeline: build FOA AMI -> roll ASG

# Reach the running instance for debugging (no SSH keys needed):
aws ssm start-session --target <instance-id> --region <region>
#   e.g. sudo journalctl -u boltz-backend -n 100

# The UI stays on Amplify; point its Backend Connection tab at this backend's URL.
```

Switch `BUILD_PROFILE` back to `prod` and rebuild for the locked-down attested image
(no SSH/SSM). See [packaging-kiwi-ng/kiwi/config.xml](packaging-kiwi-ng/kiwi/config.xml)
for the `prod` vs `foa` profile definitions.

### Building AMI with Kiwi (manual)

The pipeline builds the AMI automatically (via `package-and-upload.sh`). To build it
by hand instead:

```bash
cd packaging-kiwi-ng/scripts
./install-deps.sh
sudo ./build.sh              # add --profile foa for a debuggable SSH/SSM image (default: prod)
./upload-ami.sh
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/predict` | POST | Submit one protein sequence for 3D structure prediction (folding) |
| `/api/v1/results/{job_id}` | GET | Get folding results (PDB structure + pLDDT confidence) |
| `/api/v1/attestation` | GET | Generate a signed attestation document (verified in the browser) |
| `/health` | GET | Health check |

## Attestation Document

The attestation document includes:

- **PCR Values**: Cryptographic measurements of platform state
  - PCR0-7: Boot measurements (BIOS, bootloader, kernel)
  - PCR16: Boltz model weights hash (SHA-384)
- **Certificate Chain**: AWS Nitro root of trust
- **Nonce**: Fresh randomness to prevent replay attacks
- **Timestamp**: Document generation time

Example:
```json
{
  "timestamp": "2026-05-01T18:37:00Z",
  "nonce": "abc123...",
  "pcr_values": {
    "0": "3d458cfe55cc...",
    "16": "21b9efbc1848..."
  },
  "certificate_chain": ["MIIC...", "..."],
  "enclave_info": {
    "enclave_type": "aws-nitro",
    "module_id": "nitro-tpm-1.0"
  }
}
```

## Security Considerations

- **TPM access**: the service requires access to `/dev/tpmrm0`. The unprivileged `boltz`
  service user is granted this through membership in the `tss` group (a udev rule sets group
  ownership and `0660` permissions on the TPM device), so no root or sudo is required for
  reading or extending PCRs.
- **Model integrity**: the model hash is computed at startup and extended into PCR16.
- **Explicit-Deny enforcement**: the KMS key policy carries an explicit `Deny` on
  `kms:Decrypt` for any request whose NitroTPM PCRs are missing or incorrect (one
  `StringNotEquals` Deny per PCR, with no `Null` guard: because `StringNotEquals` is a negated
  operator, a missing PCR key also matches, so an unattested call that carries no Recipient is
  denied as well). Because an explicit Deny overrides every Allow, decryption occurs only
  inside a correctly attested instance. The model key binds PCR4/7/12; the sequence key adds
  PCR16.
- **Single-purpose CMK**: the model CMK (`alias/boltz-model-key`) is used only for the
  attestation-gated envelope encryption; the models bucket uses SSE-S3 at rest, so the CMK is
  never invoked by a non-attested path and the explicit Deny does not interfere with S3 reads.

## Cleanup

Tear down the stack with the provided script rather than a plain `cdk destroy`:

```bash
# The artifacts are region-scoped, so point the CLI at the stack's region first:
export AWS_REGION=us-east-2

./scripts/cleanup.sh                      # delete BoltzAttestationStack only
./scripts/cleanup.sh MyStack              # or pass a stack name
./scripts/cleanup.sh --purge-artifacts    # also remove out-of-band artifacts (deploy-from-scratch)
```

### Why not a plain `cdk destroy`

The stack includes a CodeBuild reserved-capacity fleet (LINUX_EC2). When
CloudFormation deletes a fleet it moves to `PENDING_DELETION` and can take up to
about an hour to drain, longer than CloudFormation's stabilization window, so a
plain destroy fails the fleet with `"Exceeded attempts to wait" (NotStabilized)`
and leaves the stack in `DELETE_FAILED`. `cleanup.sh` works around this by
**deleting the fleet up front** (it then drains in parallel and is usually gone
by the time CloudFormation reaches it) and, if the stack still lands in
`DELETE_FAILED`, retrying with the fleet **retained** so the delete completes
immediately. The fleet ARN is read from `cdk/cdk-outputs.json` (the
`CodeBuildFleetArn` output) when present, otherwise discovered from the live stack.

### Handled automatically by the stack delete

- **S3 buckets** (build source/AMI artifacts, the CodePipeline artifacts bucket, sequences, models): `autoDeleteObjects` empties then deletes them.
- **KMS keys** (`alias/boltz-model-key`, `alias/boltz-sequence-key`): scheduled for deletion; the aliases are freed on delete, so a redeploy recreates them cleanly. They are not billed while pending.
- **Cognito**, and the SSM params `/boltz-attestation/*` (the AMI-id and PCR seed params carry an `onDelete` handler), `/boltz/notifications/prod`, and `/boltz/models/latest`: removed with the stack.

### Not handled by the stack delete (out-of-band): use `--purge-artifacts`

These are created outside CloudFormation and survive a stack delete:

- **Attested AMIs** (`boltz-protein-folding-attestable-*`) registered by CodeBuild, and their **backing EBS snapshots**.
- **Runtime-written SSM params** under `/boltz/models/*` (the progress and version entries the model-workflow Lambda writes).

`./scripts/cleanup.sh --purge-artifacts` deregisters those AMIs (strictly matched
by the `boltz-protein-folding-attestable` name prefix, so unrelated AMIs in a
shared account are never touched), deletes their snapshots, and removes the
`/boltz/models/*` params.

### Deploy from scratch

```bash
export AWS_REGION=us-east-2
./scripts/cleanup.sh --purge-artifacts
cd cdk && npx cdk deploy BoltzAttestationStack --outputs-file cdk-outputs.json && cd ..
./scripts/package-and-upload.sh                          # pipeline: build attested AMI + roll the ASG
./cdk/scripts/deploy-frontend.sh BoltzAttestationStack   # publish the Amplify frontend
```

## Documentation

See the [docs/](docs/) folder for comprehensive documentation:

- [Application Overview](docs/index.html)
- [Packaging with Kiwi](docs/packaging.html)
- [Developer Guide](docs/developer-guide.html)
- [Cryptographic Attestation](docs/attestation.html)

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## References

- [Boltz Model](https://github.com/jwohlwend/boltz)
- [AWS Nitro Enclaves Attestation](https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html)
- [AWS NitroTPM](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm.html)
- [Kiwi Image Builder](https://osinside.github.io/kiwi/)