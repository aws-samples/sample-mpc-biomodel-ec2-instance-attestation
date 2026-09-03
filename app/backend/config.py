"""
Application configuration settings.

Loads configuration from environment variables with sensible defaults.
"""

import os
import json
import urllib.request
from typing import Optional
from pydantic import BaseModel


def _resolve_region_from_imdsv2() -> Optional[str]:
    """
    Resolve the AWS region from IMDSv2 and export it into the environment so every
    boto3 client (KMS decrypt, S3 download) can find it.

    The attested AMI runs no code that sets a region and boto3's own IMDS region
    discovery is unreliable here, so on the instance boto3 raises "You must specify
    a region". Rather than hardcode us-east-2 in the systemd unit (which would pin
    the region-portable AMI to one region), we query IMDSv2 at startup: fetch a
    token via PUT, then read the instance identity document. Best-effort and quick
    to fail so local/dev runs (no IMDS) fall through to any existing env value.
    """
    for var in ("AWS_REGION", "AWS_DEFAULT_REGION"):
        if os.environ.get(var):
            return os.environ[var]
    # These call the EC2 Instance Metadata Service at the link-local address
    # 169.254.169.254, which is HTTP-only (no TLS endpoint exists) and never leaves the
    # instance. The URLs are fixed string literals, not attacker-influenced input, so the
    # urllib/urlopen scheme warnings do not apply.
    try:
        # nosemgrep: insecure-request-object
        token_req = urllib.request.Request(  # nosec B310
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
        )
        # nosemgrep: dynamic-urllib-use-detected
        token = urllib.request.urlopen(token_req, timeout=1).read().decode()  # nosec B310
        # nosemgrep: insecure-request-object
        doc_req = urllib.request.Request(  # nosec B310
            "http://169.254.169.254/latest/dynamic/instance-identity/document",
            headers={"X-aws-ec2-metadata-token": token},
        )
        # nosemgrep: dynamic-urllib-use-detected
        region = json.loads(urllib.request.urlopen(doc_req, timeout=1).read().decode())["region"]  # nosec B310
        os.environ["AWS_REGION"] = region
        os.environ["AWS_DEFAULT_REGION"] = region
        return region
    except Exception:
        return None


# Resolve region at import time — config is imported before any boto3 client is built.
_AWS_REGION = _resolve_region_from_imdsv2()


def _cuda_available() -> bool:
    """Check if CUDA is available for GPU acceleration."""
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


class Settings(BaseModel):
    """Application settings loaded from environment variables."""
    
    # Server configuration
    port: int = int(os.getenv("PORT", "8000"))
    frontend_port: int = int(os.getenv("FRONTEND_PORT", "8080"))
    # Binds all interfaces so the private NLB can reach the app; the instance sits in
    # an isolated subnet with no public IP, reachable only through the internal NLB.
    host: str = os.getenv("HOST", "0.0.0.0")  # nosec B104
    debug: bool = os.getenv("DEBUG", "false").lower() == "true"
    
    # Model configuration
    model_path: str = os.getenv("MODEL_PATH", "/models/boltz")
    model_device: str = os.getenv("MODEL_DEVICE", "cuda" if _cuda_available() else "cpu")
    max_sequence_length: int = int(os.getenv("MAX_SEQUENCE_LENGTH", "2048"))
    
    # Attestation configuration
    enable_attestation: bool = os.getenv("ENABLE_ATTESTATION", "true").lower() == "true"
    tpm_device: str = os.getenv("TPM_DEVICE", "/dev/tpmrm0")
    attestation_pcr_banks: list = ["sha256"]
    
    # Security configuration
    api_key_header: str = "X-API-Key"
    allowed_origins: list = os.getenv("ALLOWED_ORIGINS", "*").split(",")
    
    # Logging configuration
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    
    # Job configuration
    max_concurrent_jobs: int = int(os.getenv("MAX_CONCURRENT_JOBS", "4"))
    job_timeout_seconds: int = int(os.getenv("JOB_TIMEOUT_SECONDS", "3600"))
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


# Singleton settings instance
_settings: Optional[Settings] = None


def get_settings() -> Settings:
    """Get the application settings singleton."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings