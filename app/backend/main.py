"""
Boltz Protein Folding API Server

This FastAPI application provides endpoints for secure protein structure prediction
using the Boltz model, with support for hardware-based attestation via AWS NitroTPM.
"""

import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import structlog

from backend.api.routes import router as api_router
from backend.config import Settings

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer()
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()

# Load settings
settings = Settings()

# Create FastAPI application
app = FastAPI(
    title="Boltz Protein Folding API",
    description="Secure protein structure prediction with hardware attestation",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Configure CORS for the Amplify-hosted frontend.
# Set CORS_ORIGINS to a comma-separated list of allowed origins (the Amplify
# domain[s]). A wildcard origin is never combined with credentials: the CORS spec
# forbids `Access-Control-Allow-Origin: *` together with credentialed requests, and
# doing so would be insecure. If CORS_ORIGINS is unset we default to a closed policy
# (no cross-origin access) rather than allowing every origin.
cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
allow_wildcard = cors_origins == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    # Credentials cannot be used with a wildcard origin; only enable them for an
    # explicit allowlist.
    allow_credentials=not allow_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(api_router, prefix="/api/v1")

# The UI is the React app in the repo-root `frontend/` folder, hosted on AWS Amplify —
# the backend is API-only and no longer serves any static frontend. (The legacy
# vanilla-JS app/frontend and its static-serve routes were removed.)
@app.get("/")
async def root():
    """API root — the UI lives on Amplify; this service is API-only."""
    return {"message": "Boltz Protein Folding API", "docs": "/docs"}


@app.get("/health")
async def health_check():
    """Health check endpoint for load balancers and monitoring."""
    return {
        "status": "healthy",
        "service": "boltz-protein-folding",
        "version": "1.0.0",
        "attestation_enabled": settings.enable_attestation,
    }


@app.on_event("startup")
async def startup_event():
    """Initialize services on application startup."""
    logger.info(
        "Starting Boltz Protein Folding API",
        port=settings.port,
        attestation_enabled=settings.enable_attestation,
    )
    
    # Initialize the Boltz model service. Pick the accelerator from what torch can
    # actually see at runtime: GPU instances (g5/g6/g4dn) have a CUDA-enabled torch and
    # an attached NVIDIA GPU, so use "gpu"; otherwise fall back to "cpu". Previously
    # this was hardcoded to "cpu", so predictions ran on CPU even on a GPU box (idle
    # GPU, very slow diffusion sampling).
    def _detect_accelerator() -> str:
        try:
            import torch
            if torch.cuda.is_available():
                return "gpu"
        except Exception as e:
            logger.warning("torch CUDA probe failed; using CPU", error=str(e))
        return "cpu"

    accelerator = _detect_accelerator()
    # MSA: the attested instance has NO outbound internet, so it CANNOT call the remote
    # ColabFold MSA server (api.colabfold.com). Passing --use_msa_server would hang/fail
    # at MSA generation. Default OFF => Boltz runs single-sequence prediction (works
    # offline; lower accuracy than MSA-backed folding). Override with BOLTZ_USE_MSA_SERVER=true
    # only in a networked/dev environment. (Full-accuracy offline path = precomputed
    # per-sequence MSA passed via the input YAML — a future enhancement.)
    use_msa_server = os.getenv("BOLTZ_USE_MSA_SERVER", "false").lower() == "true"
    from backend.services.boltz_service import BoltzService
    app.state.boltz_service = BoltzService(
        cache_dir=str(settings.model_path) if settings.model_path else "/opt/boltz/cache",
        output_dir="/opt/boltz/predictions",
        use_msa_server=use_msa_server,
        use_potentials=True,
        accelerator=accelerator,
    )

    logger.info(
        "Boltz service initialized",
        boltz_available=app.state.boltz_service.is_available(),
        accelerator=accelerator,
    )
    
    # Initialize the Attestation service once at startup
    # This ensures PCR16 is extended with the model hash early
    if settings.enable_attestation:
        from backend.services.attestation import AttestationService
        app.state.attestation_service = AttestationService()
        
        logger.info(
            "Attestation service initialized",
            tpm_available=app.state.attestation_service.is_available(),
            model_hash=app.state.attestation_service.get_model_hash()[:16] + "...",
        )
        
        # Initialize the KMS service for encrypted sequence handling
        from backend.services.kms_service import KMSService
        app.state.kms_service = KMSService(
            attestation_service=app.state.attestation_service,
        )
        
        logger.info(
            "KMS service initialized",
            attestation_available=app.state.attestation_service.is_available(),
        )


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on application shutdown."""
    logger.info("Shutting down Boltz Protein Folding API")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        # Bind all interfaces: the instance is in an isolated subnet with no public IP
        # and is reachable only through the internal NLB.
        host="0.0.0.0",  # nosec B104
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
    )