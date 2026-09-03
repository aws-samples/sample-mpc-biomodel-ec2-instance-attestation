# Boltz Protein Folding Application

Application code for the secure protein-folding demo. It predicts a protein's **3D
structure** from a single sequence using the [Boltz-1 model](https://github.com/jwohlwend/boltz),
running on an **AWS NitroTPM-attested** EC2 instance so sensitive sequences and model
weights are only ever decrypted on hardware that can prove its integrity.

> NitroTPM (a virtual TPM 2.0 on Nitro), **not** Nitro Enclaves. Attestation is
> TPM-quote / PCR based; there is no separate enclave process.

## Layout

```
app/
├── backend/                 # FastAPI service (this is what runs on the attested EC2 AMI)
│   ├── main.py              # App entry: CORS, service wiring, accelerator/MSA config
│   ├── api/
│   │   ├── routes.py        # Predict, results, jobs, attestation, model reload
│   │   └── models.py        # Pydantic request/response models
│   ├── services/
│   │   ├── boltz_service.py     # Boltz CLI wrapper (input YAML, GPU/CPU, MSA mode)
│   │   ├── attestation.py       # NitroTPM attestation + PCR16 model hash
│   │   ├── attestation_validator.py  # COSE / cert-chain verification
│   │   ├── kms_service.py       # KMS attestation-Recipient decrypt (envelope)
│   │   └── job_store.py         # On-disk + in-memory prediction job store
│   └── config.py            # Settings (env-driven) + IMDSv2 region resolution
├── frontend/                # React/Vite UI — hosted on AWS Amplify (see app/frontend/README.md)
├── shared/                  # constants.py / utils.py (shared helpers)
└── requirements.txt         # Backend Python dependencies (baked into the AMI)
```

> Note: `Dockerfile` / `docker-compose.yml` are legacy and not part of the deployment.
> The backend ships inside the kiwi-ng attested AMI (see `packaging-kiwi-ng/`); the
> frontend is built and deployed to Amplify. Neither uses Docker.

## How it runs

- **Backend**: baked into the attested AMI, started by systemd (`boltz-backend`) as
  `uvicorn backend.main:app` on port 8000. Reachable only via API Gateway → VPC Link →
  internal NLB (not publicly exposed). Requests are authenticated with Cognito JWTs.
- **Frontend**: the React app in `frontend/`, hosted on AWS Amplify. It points at the
  backend's API Gateway URL (set on its Backend Connection tab).

See the repo-root [README](../README.md) for the full architecture and deploy flow, and
[app/frontend/README.md](frontend/README.md) for the UI.

## What it predicts

Single-protein **3D structure prediction** (folding). It returns a PDB structure and a
pLDDT structure-confidence score. It does **not** do docking, protein/DNA/ligand
complexes, or binding-affinity prediction. On the internet-isolated instance it runs
single-sequence (no MSA server), which is lower accuracy than MSA-backed folding.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/predict` | Submit one protein sequence for folding |
| GET | `/api/v1/results/{job_id}` | Get folding results (PDB + pLDDT) |
| GET | `/api/v1/jobs` | List prediction jobs |
| GET | `/api/v1/attestation` | Get an attestation document (optionally with a nonce) |
| POST | `/api/v1/verify` | Verify an attestation document |
| POST | `/api/v1/models/reload` | Async in-place reload of encrypted weights into the cache |
| GET | `/api/v1/models/reload/status` | Poll the in-place reload status |
| GET | `/health` | Health check |

## Key environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `8000` |
| `MODEL_PATH` / `BOLTZ_CACHE` | Boltz model cache directory (PCR16-measured) | `/opt/boltz/models` |
| `ENABLE_ATTESTATION` | Enable NitroTPM attestation | `true` |
| `CORS_ORIGINS` | Comma-separated allowed origins (Amplify URL) | `*` |
| `BOLTZ_USE_MSA_SERVER` | Use the remote MSA server (needs internet; off on the TEE) | `false` |
| `MODELS_BUCKET` | S3 bucket holding encrypted weights | `boltz-models-prod` |
| `LOG_LEVEL` | Logging verbosity | `INFO` |

The accelerator (`gpu`/`cpu`) is auto-detected at startup from `torch.cuda.is_available()`.

## License

MIT-0. See the repository root for details.
