"""
Pydantic models for API request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, validator
import re


class JobStatus(str, Enum):
    """Status of a protein folding job."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class SequenceType(str, Enum):
    """Type of biological sequence."""
    PROTEIN = "protein"
    RNA = "rna"
    DNA = "dna"


class PredictionRequest(BaseModel):
    """Request model for protein structure prediction."""
    
    sequence: Optional[str] = Field(
        default=None,
        description="Protein sequence in single-letter amino acid code (plaintext)",
        min_length=10,
        max_length=2048,
    )
    sequence_type: SequenceType = Field(
        default=SequenceType.PROTEIN,
        description="Type of biological sequence",
    )
    name: Optional[str] = Field(
        default=None,
        description="Optional name for the sequence",
        max_length=256,
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additional prediction options",
    )
    # Encrypted sequence: the client points at the KMS-sealed object in S3 (s3_bucket +
    # s3_key); the attested backend fetches the ciphertext and reads the encryption context
    # from the object's metadata, then decrypts under attestation. The ciphertext is never
    # sent in the request body.
    s3_bucket: Optional[str] = Field(
        default=None,
        description="S3 bucket holding the encrypted sequence (used with s3_key)",
    )
    s3_key: Optional[str] = Field(
        default=None,
        description="S3 key where the encrypted sequence is stored (used with s3_bucket)",
    )
    kms_key_id: Optional[str] = Field(
        default=None,
        description="KMS key ID used for encryption",
    )
    
    @validator("sequence")
    def validate_sequence(cls, v, values):
        """Validate that the sequence contains only valid characters."""
        if v is None:
            return v
            
        sequence_type = values.get("sequence_type", SequenceType.PROTEIN)
        
        # Remove whitespace and convert to uppercase
        v = re.sub(r'\s+', '', v.upper())
        
        if sequence_type == SequenceType.PROTEIN:
            # Valid amino acid codes (including ambiguous codes)
            valid_chars = set("ACDEFGHIKLMNPQRSTVWYBXZJUO*-")
            invalid_chars = set(v) - valid_chars
            if invalid_chars:
                raise ValueError(
                    f"Invalid amino acid characters: {', '.join(invalid_chars)}"
                )
        elif sequence_type == SequenceType.DNA:
            valid_chars = set("ACGTNRYSWKMBDHV-")
            invalid_chars = set(v) - valid_chars
            if invalid_chars:
                raise ValueError(
                    f"Invalid DNA characters: {', '.join(invalid_chars)}"
                )
        elif sequence_type == SequenceType.RNA:
            valid_chars = set("ACGUNRYSWKMBDHV-")
            invalid_chars = set(v) - valid_chars
            if invalid_chars:
                raise ValueError(
                    f"Invalid RNA characters: {', '.join(invalid_chars)}"
                )
        
        return v
    
    @validator("s3_key", always=True)
    def validate_has_sequence(cls, v, values):
        """Ensure either a plaintext sequence or an S3-stored encrypted sequence is provided."""
        if v is None and values.get("sequence") is None:
            raise ValueError(
                "Either 'sequence' (plaintext) or 's3_bucket' + 's3_key' (encrypted in S3) "
                "must be provided"
            )
        if v is not None and not values.get("s3_bucket"):
            raise ValueError("'s3_bucket' is required when 's3_key' is provided")
        return v

    class Config:
        json_schema_extra = {
            "examples": [
                {
                    "summary": "Plaintext sequence",
                    "value": {
                        "sequence": "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH",
                        "sequence_type": "protein",
                        "name": "Hemoglobin alpha subunit",
                    }
                },
                {
                    "summary": "Encrypted sequence in S3 (backend fetches + attested-decrypts)",
                    "value": {
                        "s3_bucket": "boltz-sequences-...",
                        "s3_key": "biologist/<user>/sequences/abc123.enc",
                        "name": "Encrypted sequence",
                    }
                }
            ]
        }


class PredictionResponse(BaseModel):
    """Response model for prediction submission."""
    
    job_id: str = Field(..., description="Unique identifier for the prediction job")
    status: JobStatus = Field(..., description="Current status of the job")
    message: str = Field(..., description="Status message")
    created_at: datetime = Field(..., description="Job creation timestamp")
    estimated_time_seconds: Optional[int] = Field(
        default=None,
        description="Estimated time to completion in seconds",
    )


class AtomCoordinate(BaseModel):
    """3D coordinate for an atom."""
    
    atom_name: str
    residue_name: str
    residue_number: int
    chain_id: str
    x: float
    y: float
    z: float
    element: str
    b_factor: float = 0.0


class StructureResult(BaseModel):
    """Protein structure prediction result."""
    
    pdb_string: str = Field(..., description="PDB format structure")
    confidence_score: float = Field(
        ...,
        description="Overall prediction confidence (0-1)",
        ge=0.0,
        le=1.0,
    )
    per_residue_confidence: List[float] = Field(
        ...,
        description="Per-residue confidence scores",
    )
    coordinates: Optional[List[AtomCoordinate]] = Field(
        default=None,
        description="Atom coordinates (if requested)",
    )


class JobResult(BaseModel):
    """Complete job result including structure and metadata."""
    
    job_id: str
    status: JobStatus
    sequence: str
    sequence_length: int
    sequence_name: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None
    processing_time_seconds: Optional[float] = None
    structure: Optional[StructureResult] = None
    error_message: Optional[str] = None
    attestation: Optional[Dict[str, Any]] = None
    # Progress tracking fields
    progress: int = Field(default=0, ge=0, le=100, description="Progress percentage 0-100")
    progress_message: Optional[str] = Field(default=None, description="Current progress status message")
    progress_stage: Optional[str] = Field(default=None, description="Current processing stage")


class AttestationDocument(BaseModel):
    """Hardware attestation document."""
    
    timestamp: datetime
    nonce: str
    pcr_values: Dict[str, str]
    signature: str
    certificate_chain: List[str]
    enclave_info: Dict[str, Any]
    user_data: Optional[str] = None  # Signed user_data baked into the attestation (e.g. the instance role ARN)
    raw_attestation: Optional[str] = None  # Base64-encoded raw CBOR attestation
    certificates: Optional[List[Dict[str, Any]]] = None  # Parsed certificate info
    public_key: Optional[str] = None  # PEM-encoded public key for encrypted responses
    public_key_attestation: Optional[str] = None  # Signature binding key to attestation


class AttestationVerifyRequest(BaseModel):
    """Request to verify an attestation document."""
    
    attestation: AttestationDocument
    expected_pcrs: Optional[Dict[str, str]] = None


class AttestationVerifyResponse(BaseModel):
    """Response from attestation verification."""
    
    valid: bool
    message: str
    verified_at: datetime
    enclave_info: Optional[Dict[str, Any]] = None


class ErrorResponse(BaseModel):
    """Standard error response."""
    
    error: str
    detail: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)