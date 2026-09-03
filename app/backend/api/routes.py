"""
API route definitions for the Boltz Protein Folding service.
"""
from __future__ import annotations

import uuid
import hashlib
from datetime import datetime
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException, Request, BackgroundTasks
from fastapi.responses import FileResponse, Response
import structlog

from backend.api.models import (
    PredictionRequest,
    PredictionResponse,
    JobResult,
    JobStatus,
    AttestationDocument,
    AttestationVerifyRequest,
    AttestationVerifyResponse,
    ErrorResponse,
)
from backend.services.job_store import JobStore
from backend.services.kms_service import (
    KMSService,
    KMSDecryptionError,
    AttestationRequiredError,
)

logger = structlog.get_logger()

router = APIRouter()

# Global job store - will be initialized in main.py
job_store: Optional[JobStore] = None


def get_job_store() -> JobStore:
    """Get the global job store, initialize if needed."""
    global job_store
    if job_store is None:
        job_store = JobStore()
    return job_store


@router.post(
    "/predict",
    response_model=PredictionResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Submit protein sequence for structure prediction",
    description="""Submit a protein sequence to predict its 3D structure using the Boltz model.
    
    Supports both plaintext sequences and KMS-encrypted sequences. When using encrypted
    sequences, the backend will decrypt using KMS with attestation, ensuring that
    decryption only occurs on a trusted platform.""",
)
async def predict_structure(
    request: PredictionRequest,
    background_tasks: BackgroundTasks,
    req: Request,
):
    """
    Submit a protein sequence for structure prediction.
    
    The prediction runs asynchronously. Use the returned job_id to check status
    and retrieve results via the /results/{job_id} endpoint.
    
    For encrypted sequences:
    1. The sequence data is decrypted using KMS with attestation
    2. This proves the backend is running on a trusted platform
    3. The decrypted sequence is then processed normally
    """
    # Plaintext sequence by default. If the client points at an encrypted object in S3
    # (s3_bucket + s3_key), the attested backend fetches the ciphertext and its encryption
    # context from S3 and decrypts under attestation. The ciphertext is never sent in the
    # request body.
    sequence = request.sequence

    if request.s3_bucket and request.s3_key:
        import boto3
        import json as _json
        logger.info("Fetching encrypted sequence from S3", bucket=request.s3_bucket, s3_key=request.s3_key)
        try:
            s3 = boto3.client("s3")
            obj = s3.get_object(Bucket=request.s3_bucket, Key=request.s3_key)
            ciphertext_b64 = obj["Body"].read().decode("utf-8")
            raw_ctx = (obj.get("Metadata") or {}).get("encryption-context")
            enc_context = _json.loads(raw_ctx) if raw_ctx else None
        except Exception as e:
            logger.error("Failed to fetch encrypted sequence from S3", error=str(e))  # nosemgrep: logging-error-without-handling - log at source, then re-raise as HTTPException
            raise HTTPException(
                status_code=400,
                detail=f"Failed to fetch encrypted sequence from S3: {str(e)}",
            )

        logger.info(
            "Received encrypted prediction request",
            s3_key=request.s3_key,
            has_encryption_context=enc_context is not None,
            name=request.name,
        )
        try:
            # Get or create KMS service
            kms_service = getattr(req.app.state, 'kms_service', None)
            if kms_service is None:
                kms_service = KMSService()

            # Decrypt the sequence under attestation
            sequence = kms_service.decrypt_sequence(
                encrypted_data=ciphertext_b64,
                s3_key=request.s3_key,
                encryption_context=enc_context,
            )
            logger.info(
                "Successfully decrypted sequence",
                sequence_length=len(sequence),
                s3_key=request.s3_key,
            )
        except AttestationRequiredError as e:
            logger.error("Attestation required but not available", error=str(e))  # nosemgrep: logging-error-without-handling - log at source, then re-raise as HTTPException
            raise HTTPException(
                status_code=503,
                detail="Attestation not available. Cannot decrypt encrypted sequences without attestation.",
            )
        except KMSDecryptionError as e:
            logger.error("KMS decryption failed", error=str(e))  # nosemgrep: logging-error-without-handling - log at source, then re-raise as HTTPException
            raise HTTPException(
                status_code=400,
                detail=f"Failed to decrypt sequence: {str(e)}",
            )
    else:
        logger.info(
            "Received plaintext prediction request",
            sequence_length=len(sequence) if sequence else 0,
            sequence_type=request.sequence_type,
            name=request.name,
        )
    
    if not sequence:
        raise HTTPException(
            status_code=400,
            detail="No sequence provided (neither plaintext nor encrypted)",
        )
    
    # Generate job ID
    job_id = str(uuid.uuid4())
    created_at = datetime.utcnow()
    
    # Create job record
    job = JobResult(
        job_id=job_id,
        status=JobStatus.PENDING,
        sequence=sequence,
        sequence_length=len(sequence),
        sequence_name=request.name,
        created_at=created_at,
        progress=0,
        progress_message="Job submitted, waiting to start...",
        progress_stage="queued",
    )
    
    # Save to persistent store
    store = get_job_store()
    store.create_job(job)
    
    # Estimate processing time based on sequence length
    estimated_time = estimate_processing_time(len(sequence))
    
    # Queue the prediction task
    background_tasks.add_task(
        run_prediction,
        job_id=job_id,
        sequence=sequence,
        options=request.options or {},
        name=request.name,
        boltz_service=req.app.state.boltz_service,
    )
    
    return PredictionResponse(
        job_id=job_id,
        status=JobStatus.PENDING,
        message="Prediction job submitted successfully",
        created_at=created_at,
        estimated_time_seconds=estimated_time,
    )


@router.get(
    "/results/{job_id}",
    response_model=JobResult,
    responses={404: {"model": ErrorResponse}},
    summary="Get prediction results",
    description="Retrieve the results of a protein structure prediction job.",
)
async def get_results(job_id: str, req: Request):
    """
    Get the results of a prediction job.
    
    Returns the job status and, if completed, the predicted structure
    along with confidence scores and attestation document.
    """
    store = get_job_store()
    job = store.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    # If job is completed and attestation is enabled, generate attestation
    if job.status == JobStatus.COMPLETED and job.attestation is None:
        try:
            # Use singleton attestation service from app.state if available
            attestation_service = getattr(req.app.state, 'attestation_service', None)
            if attestation_service is None:
                from backend.services.attestation import AttestationService
                attestation_service = AttestationService()
            if attestation_service.is_available():
                attestation = attestation_service.generate_attestation(
                    data_hash=hash_job_data(job)
                )
                job.attestation = attestation.model_dump() if hasattr(attestation, 'model_dump') else dict(attestation)
                store.update_job(job)
        except Exception as e:
            logger.warning("Failed to generate attestation", error=str(e))
    
    return job


@router.get(
    "/jobs",
    response_model=list[JobResult],
    summary="List all jobs",
    description="List all prediction jobs with pagination.",
)
async def list_jobs(
    status: Optional[JobStatus] = None,
    limit: int = 100,
    offset: int = 0,
):
    """List all prediction jobs, optionally filtered by status."""
    store = get_job_store()
    jobs = store.list_jobs(status=status, limit=limit, offset=offset)
    return jobs


@router.get(
    "/jobs/count",
    summary="Get job count",
    description="Get the total count of jobs.",
)
async def get_job_count(status: Optional[JobStatus] = None):
    """Get total job count."""
    store = get_job_store()
    return {"count": store.get_job_count(status)}


@router.delete(
    "/jobs/{job_id}",
    summary="Delete a job",
    description="Delete a prediction job and its results.",
)
async def delete_job(job_id: str):
    """Delete a job from the store."""
    store = get_job_store()
    
    if not store.delete_job(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    return {"message": f"Job {job_id} deleted successfully"}


@router.get(
    "/jobs/{job_id}/files",
    summary="List job files",
    description="List all files associated with a job.",
)
async def list_job_files(job_id: str):
    """List available files for a job."""
    store = get_job_store()
    job = store.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    files = store.get_job_files(job_id)
    
    # Return list of available downloads
    available = []
    if files.get("pdb"):
        available.append({
            "name": "structure.pdb",
            "type": "pdb",
            "url": f"/api/v1/jobs/{job_id}/download/pdb",
        })
    if files.get("cif"):
        available.append({
            "name": "structure.cif",
            "type": "cif",
            "url": f"/api/v1/jobs/{job_id}/download/cif",
        })
    if files.get("confidence"):
        available.append({
            "name": "confidence.json",
            "type": "json",
            "url": f"/api/v1/jobs/{job_id}/download/confidence",
        })
    if files.get("job_metadata"):
        available.append({
            "name": "job.json",
            "type": "json",
            "url": f"/api/v1/jobs/{job_id}/download/metadata",
        })
    
    return {"job_id": job_id, "files": available}


@router.get(
    "/jobs/{job_id}/download/{file_type}",
    summary="Download job file",
    description="Download a specific file associated with a job.",
)
async def download_job_file(job_id: str, file_type: str):
    """Download a job-related file."""
    store = get_job_store()
    job = store.get_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    files = store.get_job_files(job_id)
    
    file_map = {
        "pdb": ("structure.pdb", "chemical/x-pdb", files.get("pdb")),
        "cif": ("structure.cif", "chemical/x-cif", files.get("cif")),
        "confidence": ("confidence.json", "application/json", files.get("confidence")),
        "metadata": ("job.json", "application/json", files.get("job_metadata")),
    }
    
    if file_type not in file_map:
        raise HTTPException(status_code=400, detail=f"Invalid file type: {file_type}")
    
    filename, media_type, filepath = file_map[file_type]
    
    if not filepath:
        raise HTTPException(status_code=404, detail=f"File not found: {file_type}")
    
    return FileResponse(
        filepath,
        media_type=media_type,
        filename=f"{job_id}_{filename}",
    )


@router.get(
    "/jobs/{job_id}/pdb",
    summary="Get PDB content",
    description="Get the PDB structure as text.",
)
async def get_pdb_content(job_id: str):
    """Get PDB content for visualization."""
    store = get_job_store()
    pdb_content = store.get_pdb_content(job_id)
    
    if not pdb_content:
        raise HTTPException(status_code=404, detail=f"PDB not found for job {job_id}")
    
    return Response(content=pdb_content, media_type="text/plain")


@router.get(
    "/attestation",
    response_model=AttestationDocument,
    summary="Get attestation document",
    description="Generate a fresh attestation document proving enclave integrity.",
)
async def get_attestation(req: Request, nonce: Optional[str] = None):
    """
    Generate an attestation document.
    
    The attestation document proves that the code is running in a genuine
    AWS Nitro environment and has not been tampered with.
    """
    # Use singleton attestation service from app.state if available
    attestation_service = getattr(req.app.state, 'attestation_service', None)
    if attestation_service is None:
        from backend.services.attestation import AttestationService
        attestation_service = AttestationService()
    
    if not attestation_service.is_available():
        raise HTTPException(
            status_code=503,
            detail="Attestation service not available (TPM not accessible)",
        )
    
    # Bind this instance's IAM role ARN (from IMDSv2) into the SIGNED attestation as
    # user_data, so the client scopes the KMS key policy to the attested principal instead
    # of a hand-typed ARN. The role ARN is what KMS enforces against the real caller
    # identity, so the principal cannot be widened by accident.
    role_arn = attestation_service._get_ec2_iam_role_arn()
    attestation = attestation_service.generate_attestation(
        nonce=nonce,
        user_data=role_arn.encode("utf-8") if role_arn else None,
    )
    return attestation


# The POST /verify endpoint was removed on purpose. It had the attested host grade its own
# attestation ("valid": true/false), which is no evidence at all — an instance that lies about
# its PCRs also returns valid=true. Verification now happens only in the relying party (the
# browser), which checks the signed document against the pinned AWS Nitro root itself
# (frontend services/attestationVerifier.ts). The backend just generates and returns the
# signed document via GET /attestation.


async def run_prediction(
    job_id: str,
    sequence: str,
    options: Dict,
    name: Optional[str],
    boltz_service,
):
    """
    Run the actual protein structure prediction.
    
    This function runs in the background and updates the job store
    with results and progress as it goes.
    """
    import asyncio
    
    logger.info("Starting prediction", job_id=job_id, sequence_length=len(sequence))
    
    store = get_job_store()
    job = store.get_job(job_id)
    
    if not job:
        logger.error("Job not found", job_id=job_id)
        return
    
    def update_progress(progress: int, message: str, stage: str):
        """Helper to update job progress."""
        job.progress = progress
        job.progress_message = message
        job.progress_stage = stage
        store.update_job(job)
    
    # Update status to processing
    job.status = JobStatus.PROCESSING
    update_progress(5, "Initializing prediction environment...", "initializing")
    
    try:
        start_time = datetime.utcnow()
        
        # Stage: Preparing input
        await asyncio.sleep(0.5)  # Small delay to show progress
        update_progress(10, "Creating input files...", "preparing")
        
        # Set name in options if provided
        if name:
            options["name"] = name
        
        # Stage: MSA alignment
        await asyncio.sleep(0.5)
        update_progress(20, "Running multiple sequence alignment...", "msa")
        
        # Create a task to simulate progress during the long-running prediction
        prediction_complete = asyncio.Event()
        
        async def simulate_progress():
            """Simulate progress updates during prediction."""
            stages = [
                (30, "MSA alignment in progress...", "msa"),
                (40, "Extracting sequence features...", "features"),
                (50, "Loading Boltz neural network...", "model"),
                (60, "Running structure prediction...", "model"),
                (70, "Diffusion sampling in progress...", "model"),
                (80, "Refining predicted structure...", "refinement"),
                (90, "Calculating confidence scores...", "confidence"),
            ]
            
            # Estimate total time based on sequence length
            # Roughly 2-3 seconds per residue for short sequences
            estimated_seconds = max(30, len(sequence) * 2)
            stage_duration = estimated_seconds / len(stages)
            
            for progress, message, stage in stages:
                if prediction_complete.is_set():
                    break
                update_progress(progress, message, stage)
                try:
                    await asyncio.wait_for(
                        prediction_complete.wait(),
                        timeout=stage_duration
                    )
                    break  # Prediction completed early
                except asyncio.TimeoutError:
                    continue  # Move to next stage
        
        # Start progress simulation in background
        progress_task = asyncio.create_task(simulate_progress())
        
        try:
            # Run the actual prediction
            result = await boltz_service.predict(sequence, options)
        finally:
            # Signal that prediction is complete
            prediction_complete.set()
            # Wait for progress task to finish
            await progress_task
        
        end_time = datetime.utcnow()
        processing_time = (end_time - start_time).total_seconds()
        
        # Update job with results
        job.status = JobStatus.COMPLETED
        job.completed_at = end_time
        job.processing_time_seconds = processing_time
        job.structure = result
        update_progress(100, "Prediction completed successfully!", "completed")
        
        logger.info(
            "Prediction completed",
            job_id=job_id,
            processing_time=processing_time,
            confidence=result.confidence_score,
        )
        
    except Exception as e:
        logger.error("Prediction failed", job_id=job_id, error=str(e))
        job.status = JobStatus.FAILED
        job.error_message = str(e)
        job.completed_at = datetime.utcnow()
        job.progress = 0
        job.progress_message = f"Failed: {str(e)}"
        job.progress_stage = "failed"
        store.update_job(job)


def estimate_processing_time(sequence_length: int) -> int:
    """Estimate processing time based on sequence length."""
    # Rough estimate: ~2 seconds per residue + 60 second base for model loading
    return 60 + (sequence_length * 2)


def hash_job_data(job: JobResult) -> str:
    """Create a hash of job data for attestation."""
    import json
    
    data = {
        "job_id": job.job_id,
        "sequence": job.sequence,
        "sequence_length": job.sequence_length,
        "pdb_hash": hashlib.sha256(
            job.structure.pdb_string.encode() if job.structure else b""
        ).hexdigest(),
        "confidence_score": job.structure.confidence_score if job.structure else None,
    }
    
    data_str = json.dumps(data, sort_keys=True)
    return hashlib.sha256(data_str.encode()).hexdigest()


# =============================================================================
# MODEL MANAGEMENT ENDPOINTS (for Biophysicist role)
# =============================================================================

# In-memory model store (in production, use a database)
model_store: Dict[str, Dict] = {}
active_model_id: Optional[str] = None


@router.get(
    "/models",
    summary="List available models",
    description="Get a list of all model versions available for deployment.",
)
async def list_models():
    """List all model versions."""
    models = list(model_store.values())
    return {
        "models": models,
        "active_model_id": active_model_id,
        "count": len(models),
    }


# =============================================================================
# IN-PLACE RELOAD (async). Registered BEFORE the parameterized /models/{model_id}*
# routes so the static paths /models/reload and /models/reload/status match first
# — FastAPI matches in registration order, otherwise /models/{model_id}/status
# greedily captures model_id="reload" and returns "Model not found".
# =============================================================================

# Downloading/decrypting ~10 GB takes minutes, far longer than the API Gateway 30s
# integration timeout — so reload is async: return 202, poll /models/reload/status.
reload_status: Dict[str, object] = {"state": "idle"}


def _reload_weights_background(version: Optional[str], s3_path: str):
    """Background: download + KMS-decrypt weights into the live cache, re-extend PCR16."""
    from pathlib import Path
    from backend.config import get_settings

    def on_progress(percent, message, stage):
        reload_status.update(state="running", version=version, stage=stage,
                             percent=percent, message=message)

    reload_status.update(state="running", version=version, stage="starting", percent=0,
                         message="Starting in-place reload", model_hash=None)
    try:
        cache_dir = Path(get_settings().model_path)
        model_hash = _download_decrypt_weights(s3_path, cache_dir, on_progress=on_progress)
        try:
            from backend.services.attestation import AttestationService
            reload_status.update(state="running", stage="extending-pcr16", percent=99,
                                 message="Extending PCR16 with the new model hash")
            AttestationService()  # re-extend PCR16 with the new on-disk model hash
        except Exception as e:
            logger.warning("PCR16 re-extension after reload failed (non-fatal)", error=str(e))
        reload_status.update(state="complete", version=version, stage="complete", percent=100,
                             model_hash=model_hash,
                             message=f"Model {version or ''} reloaded in place. PCR16 updated.")
        logger.info("In-place model reload complete", version=version, model_hash=model_hash[:16])
    except Exception as e:
        logger.error("In-place model reload failed", version=version, error=str(e))
        # Leave `stage`/`percent` as they were when the failure occurred (e.g.
        # "decrypting-key"), so the UI shows exactly where it failed.
        reload_status.update(state="failed", version=version, message=str(e))


@router.post(
    "/models/reload",
    status_code=202,
    summary="Hot-reload model weights in place (async)",
    description="""In-place model update: download the envelope-encrypted weights for
    the given version from S3, KMS-decrypt them into the live Boltz cache, and re-extend
    PCR16. Because this moves multiple GB it runs in the BACKGROUND and returns 202
    immediately — poll GET /models/reload/status for progress.""",
)
async def reload_model(request: Request, background_tasks: BackgroundTasks):
    """Start an async in-place reload of the given model version."""
    body = await request.json()
    version = body.get("version")
    s3_path = body.get("s3_path")
    if not s3_path:
        raise HTTPException(status_code=400, detail="Missing required field: s3_path")

    if reload_status.get("state") == "running":
        raise HTTPException(status_code=409, detail="A model reload is already in progress")

    logger.info("In-place model reload requested (async)", version=version, s3_path=s3_path)
    reload_status.update(state="running", version=version, stage="queued", percent=0,
                         message="Queued", model_hash=None)
    background_tasks.add_task(_reload_weights_background, version, s3_path)

    return {
        "status": "accepted",
        "version": version,
        "message": "Model reload started. Poll /api/v1/models/reload/status for progress.",
    }


@router.get(
    "/models/reload/status",
    summary="Get in-place model reload status",
    description="Poll the status of an in-place model reload (idle/running/complete/failed).",
)
async def reload_model_status():
    """Return the current in-place reload status."""
    return reload_status


@router.get(
    "/models/{model_id}",
    summary="Get model details",
    description="Get detailed information about a specific model version.",
)
async def get_model(model_id: str):
    """Get details of a specific model."""
    if model_id not in model_store:
        raise HTTPException(status_code=404, detail="Model not found")
    
    return model_store[model_id]


@router.get(
    "/models/{model_id}/status",
    summary="Get model deployment status",
    description="Check the deployment status of a specific model.",
)
async def get_model_status(model_id: str):
    """Get deployment status of a model."""
    if model_id not in model_store:
        raise HTTPException(status_code=404, detail="Model not found")
    
    model = model_store[model_id]
    return {
        "model_id": model_id,
        "status": model.get("status", "unknown"),
        "is_active": model_id == active_model_id,
        "deployed_at": model.get("deployed_at"),
        "error_message": model.get("error_message"),
    }


@router.post(
    "/models/deploy",
    summary="Deploy a new model",
    description="""Deploy a new model version to the backend. The model weights must be 
    pre-uploaded to S3 and encrypted with the appropriate KMS key. The backend will 
    decrypt the model using attestation-based KMS access.""",
)
async def deploy_model(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Deploy a new model version."""
    body = await request.json()
    
    model_id = body.get("model_id")
    s3_key = body.get("s3_key")
    name = body.get("name")
    version = body.get("version")
    checksum = body.get("checksum")
    
    if not all([model_id, s3_key, name, version]):
        raise HTTPException(
            status_code=400,
            detail="Missing required fields: model_id, s3_key, name, version"
        )
    
    logger.info(
        "Model deployment requested",
        model_id=model_id,
        name=name,
        version=version,
        s3_key=s3_key,
    )
    
    # Create model record
    model = {
        "id": model_id,
        "name": name,
        "version": version,
        "s3_key": s3_key,
        "checksum": checksum,
        "status": "deploying",
        "created_at": datetime.utcnow().isoformat(),
        "deployed_at": None,
        "error_message": None,
        "is_active": False,
    }
    
    model_store[model_id] = model
    
    # Start deployment in background
    background_tasks.add_task(
        _deploy_model_background,
        model_id,
        s3_key,
        checksum,
    )
    
    return {
        "model_id": model_id,
        "status": "deploying",
        "message": "Model deployment started",
    }


# Boltz weight files, in the order attestation.compute_boltz_model_hash aggregates
# them (must match so a deployed model's PCR16 measurement is deterministic).
BOLTZ_WEIGHT_FILES = ["boltz1_conf.ckpt", "boltz1.ckpt", "ccd.pkl"]


def _parse_s3_location(s3_path_or_key: str) -> tuple[str, str]:
    """
    Resolve a models-bucket location into (bucket, prefix).

    Requires a full 's3://bucket/weights/<version>/' URI (as written to
    /boltz/models/latest by the workflow and passed by the frontend). The instance is
    intentionally NOT configured with a bucket name — the S3 URI is always supplied by
    the caller, so the (CDK auto-generated) bucket name never needs to be baked in.
    A bare key without an s3:// bucket is rejected rather than guessing a bucket.
    """
    import os
    if s3_path_or_key.startswith("s3://"):
        rest = s3_path_or_key[len("s3://"):]
        bucket, _, prefix = rest.partition("/")
        return bucket, prefix.rstrip("/") + "/" if prefix else ""
    # Back-compat: only if MODELS_BUCKET is explicitly set (not the default path).
    bucket = os.getenv("MODELS_BUCKET")
    if not bucket:
        raise ValueError(
            f"Model S3 location must be a full s3:// URI (got {s3_path_or_key!r}); "
            "the instance is not configured with a default models bucket."
        )
    prefix = s3_path_or_key.rstrip("/")
    if prefix.endswith(".enc"):
        prefix = prefix.rsplit("/", 1)[0]
    return bucket, prefix + "/" if prefix else ""


def _download_decrypt_weights(s3_path_or_key: str, target_dir, on_progress=None) -> str:
    """
    Download the three envelope-encrypted Boltz weight files from S3, KMS-decrypt
    each into `target_dir`, and return the SHA-384 aggregate hash (same scheme as
    attestation.compute_boltz_model_hash: per-file sha384 hex digests concatenated
    as bytes in BOLTZ_WEIGHT_FILES order). Blocking (S3 + KMS + AES); call via a
    thread from async code.

    on_progress(percent: int, message: str, stage: str), if given, is called as the work
    advances (S3 download by bytes, attested data-key decrypt, blob decrypt, per file) so
    callers can surface granular progress instead of a single opaque state.
    """
    import boto3
    from pathlib import Path
    from backend.services.kms_service import get_kms_service
    from backend.services.attestation import hash_file

    def report(percent, message, stage):
        if on_progress:
            try:
                on_progress(int(percent), message, stage)
            except Exception:  # nosec B110 - progress reporting is best-effort, never fatal
                pass

    bucket, prefix = _parse_s3_location(s3_path_or_key)
    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)
    s3 = boto3.client("s3")
    kms = get_kms_service()

    import hashlib as _hashlib
    agg = _hashlib.sha384()
    n = len(BOLTZ_WEIGHT_FILES)
    for i, fname in enumerate(BOLTZ_WEIGHT_FILES, start=1):
        key = f"{prefix}{fname}.enc"
        base = (i - 1) / n
        logger.info("Downloading encrypted weight", bucket=bucket, key=key)

        # Stream the object so we can report byte-level download progress on the multi-GB
        # weights (a single .read() gives no feedback). Accumulate into one bytearray (no
        # join copy) and hand it straight to the decryptor.
        obj = s3.get_object(Bucket=bucket, Key=key)
        total = int(obj.get("ContentLength", 0) or 0)
        body = obj["Body"]
        buf = bytearray()
        last_pct = -1
        report(round(100 * base), f"Downloading {fname} ({i}/{n})", "downloading")
        while True:
            chunk = body.read(16 * 1024 * 1024)
            if not chunk:
                break
            buf.extend(chunk)
            if total:
                pct = round(100 * (base + 0.70 * (len(buf) / total) / n))
                if pct != last_pct:
                    last_pct = pct
                    report(pct, f"Downloading {fname} ({i}/{n}) — "
                           f"{len(buf)//(1024*1024)}/{total//(1024*1024)} MB", "downloading")

        # Report the two decrypt sub-steps as their own stages. The "data-key" step is the
        # attested KMS unwrap that fails (AccessDenied) on a PCR mismatch, so surfacing it
        # pinpoints a decrypt failure.
        def _stage_cb(stage, _i=i, _fname=fname, _base=base):
            if stage == "data-key":
                report(round(100 * (_base + 0.75 / n)),
                       f"Decrypting data key via attested KMS for {_fname} ({_i}/{n})",
                       "decrypting-key")
            elif stage == "blob":
                report(round(100 * (_base + 0.85 / n)),
                       f"Decrypting {_fname} ({_i}/{n})", "decrypting-blob")

        out = target / fname
        kms.decrypt_model_blob_to_file(buf, out, on_stage=_stage_cb)
        del buf
        agg.update(hash_file(out).encode())
        report(round(100 * i / n), f"{fname} ready ({i}/{n})", "file-ready")
    return agg.hexdigest()


async def _deploy_model_background(model_id: str, s3_key: str, checksum: str):
    """
    Real background deployment: download the encrypted weights from S3, KMS-decrypt
    them into a per-version staging directory, validate the SHA-384 aggregate against
    the expected checksum (if provided), and mark the model 'inactive' (ready but not
    live). activate_model swaps staging into the live Boltz cache.
    """
    import asyncio
    from pathlib import Path
    from backend.config import get_settings

    model = model_store.get(model_id)
    if not model:
        return
    try:
        settings = get_settings()
        version = model.get("version", model_id)
        # Stage under the model cache so activation is a same-filesystem move.
        staging = Path(settings.model_path) / "staging" / str(version)

        model["status"] = "downloading"
        logger.info("Model deployment: download + decrypt", model_id=model_id, s3_key=s3_key)
        model["status"] = "decrypting"
        actual_hash = await asyncio.to_thread(_download_decrypt_weights, s3_key, staging)

        model["status"] = "validating"
        model["model_hash"] = actual_hash
        # `checksum` from the workflow SSM pointer is the SHA-384 aggregate; if the
        # caller supplied one, enforce it. (The frontend upload path uses SHA-256 of
        # a single file — that path does not set this checksum, so we skip when absent.)
        if checksum and checksum != actual_hash:
            raise ValueError(
                f"Model checksum mismatch: expected {checksum[:16]}..., got {actual_hash[:16]}..."
            )

        model["staging_dir"] = str(staging)
        model["status"] = "inactive"  # decrypted + validated, ready to activate
        model["deployed_at"] = datetime.utcnow().isoformat()
        logger.info("Model deployment completed", model_id=model_id, model_hash=actual_hash[:16])
    except Exception as e:
        logger.error("Model deployment failed", model_id=model_id, error=str(e))
        if model_id in model_store:
            model_store[model_id]["status"] = "failed"
            model_store[model_id]["error_message"] = str(e)


@router.post(
    "/models/activate/{model_id}",
    summary="Activate a deployed model",
    description="Activate a deployed model version, making it the default for predictions.",
)
async def activate_model(model_id: str):
    """
    Activate a deployed model: swap its decrypted staged weights into the live Boltz
    CLI cache (MODEL_PATH), then re-extend PCR16 so attestation reflects the newly
    active model. The next `boltz predict` uses the swapped-in weights.
    """
    global active_model_id

    if model_id not in model_store:
        raise HTTPException(status_code=404, detail="Model not found")

    model = model_store[model_id]

    if model["status"] not in ["inactive", "active"]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot activate model in status: {model['status']}"
        )

    # Swap the staged weights into the live cache dir.
    try:
        await _activate_weights_on_disk(model)
    except Exception as e:
        # Error IS handled: logged and re-raised as an HTTP 500 to the caller.
        logger.error("Model activation (file swap) failed", model_id=model_id, error=str(e))  # nosemgrep: logging-error-without-handling
        raise HTTPException(status_code=500, detail=f"Failed to activate model weights: {e}")

    # Deactivate current model
    if active_model_id and active_model_id in model_store and active_model_id != model_id:
        model_store[active_model_id]["status"] = "inactive"
        model_store[active_model_id]["is_active"] = False

    # Activate new model
    model["status"] = "active"
    model["is_active"] = True
    active_model_id = model_id

    logger.info("Model activated", model_id=model_id, name=model["name"])

    return {
        "model_id": model_id,
        "status": "active",
        "message": f"Model {model['name']} v{model['version']} is now active",
        "model_hash": model.get("model_hash"),
    }


async def _activate_weights_on_disk(model: Dict) -> None:
    """
    Move the model's staged weight files into the live Boltz cache dir (MODEL_PATH),
    backing up any currently-active weights first, then re-extend PCR16. Runs the
    blocking filesystem work in a thread.
    """
    import asyncio
    import shutil
    from pathlib import Path
    from backend.config import get_settings

    staging = model.get("staging_dir")
    if not staging:
        raise ValueError("Model has no staged weights (was it deployed successfully?)")
    staging_path = Path(staging)
    cache_dir = Path(get_settings().model_path)

    def _swap():
        cache_dir.mkdir(parents=True, exist_ok=True)
        for fname in BOLTZ_WEIGHT_FILES:
            src = staging_path / fname
            if not src.exists():
                raise FileNotFoundError(f"Staged weight missing: {src}")
            dst = cache_dir / fname
            # Same-filesystem replace (staging lives under MODEL_PATH/staging).
            shutil.copy2(src, dst.with_suffix(dst.suffix + ".tmp"))
            os_replace(dst.with_suffix(dst.suffix + ".tmp"), dst)

    await asyncio.to_thread(_swap)

    # Re-measure: extend PCR16 with the now-active model hash.
    try:
        from backend.services.attestation import AttestationService
        AttestationService()  # constructor extends PCR16 with the current cache hash
    except Exception as e:
        logger.warning("PCR16 re-extension after activation failed (non-fatal)", error=str(e))


def os_replace(src, dst):
    """os.replace wrapper (atomic same-fs rename), kept importable/testable."""
    import os
    os.replace(src, dst)


@router.delete(
    "/models/{model_id}",
    summary="Delete a model",
    description="Remove a model from the system. Cannot delete the active model.",
)
async def delete_model(model_id: str):
    """Delete a model."""
    global active_model_id
    
    if model_id not in model_store:
        raise HTTPException(status_code=404, detail="Model not found")
    
    if model_id == active_model_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete the active model. Activate another model first."
        )
    
    model = model_store.pop(model_id)
    logger.info("Model deleted", model_id=model_id, name=model["name"])
    
    return {
        "message": f"Model {model['name']} v{model['version']} deleted",
    }
