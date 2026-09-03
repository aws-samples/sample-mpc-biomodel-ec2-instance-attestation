"""
Attestation Service

Provides hardware-based attestation using AWS NitroTPM.
Generates and verifies attestation documents that prove code integrity.

Based on https://github.com/aws-samples/sample-mpc-app-using-aws-nitrotpm
"""

import base64
import hashlib
import json
import os
import secrets
import subprocess  # nosec B404 - used only with fixed argv, no shell
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Any, List

import structlog

from backend.api.models import AttestationDocument
from backend.services.attestation_validator import (
    validate_attestation_document,
    generate_attestation_with_nitrotpm,
    read_pcrs_from_tpm,
    extend_pcr as tpm_extend_pcr,
)
from backend.services.certificate_parser import parse_certificate_chain

logger = structlog.get_logger()


# AWS Nitro root certificate
AWS_NITRO_ROOT_CERT = """-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----"""


# PCR index for model weights measurement
MODEL_WEIGHTS_PCR = 16

# Path to Boltz model cache
BOLTZ_MODEL_CACHE = Path(os.environ.get("BOLTZ_CACHE", "/opt/boltz/cache"))


def hash_file(filepath: Path) -> str:
    """Compute SHA-384 hash of a file."""
    sha384 = hashlib.sha384()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha384.update(chunk)
    return sha384.hexdigest()


def hash_directory(dirpath: Path) -> str:
    """Compute SHA-384 hash of all files in a directory (sorted for determinism)."""
    sha384 = hashlib.sha384()
    
    if not dirpath.exists():
        return "0" * 96  # Return zero hash if directory doesn't exist (96 chars for SHA-384)
    
    # Get all files sorted alphabetically for deterministic hashing
    files = sorted(dirpath.rglob("*"))
    
    for filepath in files:
        if filepath.is_file():
            # Include relative path in hash for structure integrity
            rel_path = filepath.relative_to(dirpath)
            sha384.update(str(rel_path).encode())
            
            # Include file hash
            with open(filepath, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    sha384.update(chunk)
    
    return sha384.hexdigest()


def compute_boltz_model_hash() -> str:
    """
    Compute SHA-384 hash of Boltz model weights.
    
    The hash covers all model files in the Boltz cache directory.
    This creates a deterministic measurement of the model being used.
    
    Uses SHA-384 to match the AWS NitroTPM attestation PCR bank.
    """
    model_dirs = [
        BOLTZ_MODEL_CACHE / "boltz1_conf.ckpt",
        BOLTZ_MODEL_CACHE / "boltz1.ckpt",
        BOLTZ_MODEL_CACHE / "ccd.pkl",
    ]
    
    # Also check ~/.boltz default location
    home_boltz = Path.home() / ".boltz"
    
    sha384 = hashlib.sha384()
    files_found = 0
    
    # Hash individual model files if they exist
    for model_path in model_dirs:
        if model_path.exists():
            if model_path.is_file():
                file_hash = hash_file(model_path)
                sha384.update(file_hash.encode())
                files_found += 1
                logger.debug("Hashed model file", path=str(model_path), hash=file_hash[:16])
    
    # Check home directory
    for model_path in [home_boltz / "boltz1_conf.ckpt", home_boltz / "boltz1.ckpt", home_boltz / "ccd.pkl"]:
        if model_path.exists() and model_path.is_file():
            file_hash = hash_file(model_path)
            sha384.update(file_hash.encode())
            files_found += 1
            logger.debug("Hashed model file", path=str(model_path), hash=file_hash[:16])
    
    # If no specific files found, hash entire cache directory
    if files_found == 0:
        if BOLTZ_MODEL_CACHE.exists():
            dir_hash = hash_directory(BOLTZ_MODEL_CACHE)
            sha384.update(dir_hash.encode())
            logger.debug("Hashed model cache directory", path=str(BOLTZ_MODEL_CACHE), hash=dir_hash[:16])
        elif home_boltz.exists():
            dir_hash = hash_directory(home_boltz)
            sha384.update(dir_hash.encode())
            logger.debug("Hashed home boltz directory", path=str(home_boltz), hash=dir_hash[:16])
    
    model_hash = sha384.hexdigest()
    logger.info("Computed Boltz model hash (SHA-384)", hash=model_hash, files_found=files_found)
    return model_hash


def boltz_model_present() -> bool:
    """True if a Boltz weight file is actually on disk (so there is a real model to hash).

    Used to decide whether PCR16 should be extended at boot: with no model present there is
    nothing to measure, so PCR16 must stay at its reset (all-zeros) value rather than being
    extended with a placeholder "empty" hash.
    """
    candidates = [
        BOLTZ_MODEL_CACHE / "boltz1_conf.ckpt",
        BOLTZ_MODEL_CACHE / "boltz1.ckpt",
        BOLTZ_MODEL_CACHE / "ccd.pkl",
        Path.home() / ".boltz" / "boltz1_conf.ckpt",
        Path.home() / ".boltz" / "boltz1.ckpt",
        Path.home() / ".boltz" / "ccd.pkl",
    ]
    return any(p.is_file() for p in candidates)


class AttestationService:
    """
    Service for generating and verifying hardware attestation documents.
    
    Uses AWS NitroTPM when available via nitro-tpm-attest tool.
    Falls back to direct TPM access via tpm2-tools.
    """
    
    def __init__(self, tpm_device: str = "/dev/tpmrm0"):
        """
        Initialize the attestation service.
        
        Args:
            tpm_device: Path to the TPM device
        """
        self.tpm_device = Path(tpm_device)
        self._tpm_available = self._check_tpm_availability()
        self._nitro_tpm_available = self._check_nitro_tpm_attest()
        self._model_hash = None
        self._model_hash_extended = False
        
        if self._nitro_tpm_available:
            logger.info("nitro-tpm-attest tool available for attestation")
        elif self._tpm_available:
            logger.info("TPM device available", device=str(self.tpm_device))
        else:
            logger.warning(
                "No TPM/attestation tools available",
                device=str(self.tpm_device)
            )
        
        # Extend PCR16 with model hash on startup
        self._extend_model_hash_to_pcr()
    
    def _extend_model_hash_to_pcr(self) -> bool:
        """
        Extend PCR16 with the hash of Boltz model weights.
        
        This should be called once at startup to measure the model.
        PCR16 is designated for application-specific measurements.
        
        Returns:
            True if extension succeeded, False otherwise
        """
        if self._model_hash_extended:
            logger.debug("Model hash already extended to PCR16")
            return True
        
        if not self._tpm_available:
            logger.warning("Cannot extend PCR16: TPM not available")
            return False

        # No model on disk yet (e.g. a fresh boot before an attested in-place reload):
        # there is nothing to measure, so leave PCR16 at its reset (all-zeros) value rather
        # than extending a placeholder "empty" hash. PCR16 then means exactly "the loaded
        # model" — it is unset until real weights are present, and the reload extends it
        # once. `_model_hash_extended` is left False so that later load does the extension.
        if not boltz_model_present():
            logger.info("No Boltz model present at startup; leaving PCR16 unextended (all-zeros)")
            return False

        try:
            # Compute model hash
            self._model_hash = compute_boltz_model_hash()
            
            # Extend PCR16 using tpm2_pcrextend
            result = tpm_extend_pcr(
                pcr_index=MODEL_WEIGHTS_PCR,
                data_hash=self._model_hash,
                tpm_device=str(self.tpm_device)
            )
            
            if result:
                self._model_hash_extended = True
                logger.info(
                    "Extended PCR16 with Boltz model hash",
                    pcr_index=MODEL_WEIGHTS_PCR,
                    model_hash=self._model_hash
                )
                return True
            else:
                logger.warning("Failed to extend PCR16 with model hash")
                return False
                
        except Exception as e:
            logger.error("Error extending PCR16 with model hash", error=str(e))
            return False
    
    def get_model_hash(self) -> str:
        """Get the computed Boltz model hash."""
        if self._model_hash is None:
            self._model_hash = compute_boltz_model_hash()
        return self._model_hash
    
    def _check_tpm_availability(self) -> bool:
        """Check if TPM device is available."""
        return self.tpm_device.exists()
    
    def _check_nitro_tpm_attest(self) -> bool:
        """Check if nitro-tpm-attest tool is available."""
        try:
            result = subprocess.run(  # nosec B603 B607 - fixed 'which' argv, no shell
                ["which", "nitro-tpm-attest"],
                capture_output=True,
                timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False
    
    def is_available(self) -> bool:
        """Check if attestation service is available."""
        return self._tpm_available or self._nitro_tpm_available
    
    def generate_attestation(
        self,
        nonce: Optional[str] = None,
        data_hash: Optional[str] = None,
        user_data: Optional[bytes] = None,
        public_key: Optional[bytes] = None,
    ) -> AttestationDocument:
        """
        Generate an attestation document using nitro-tpm-attest.
        
        This is the only path - no fallbacks. nitro-tpm-attest is baked into
        the AMI and must work for attestation to function.
        
        Args:
            nonce: Optional client-provided nonce for freshness
            data_hash: Optional hash of data to include in attestation
            user_data: Optional user data to include
            
        Returns:
            AttestationDocument with PCR values and TPM-signed certificate chain
            
        Raises:
            RuntimeError: If nitro-tpm-attest fails
        """
        timestamp = datetime.utcnow()
        
        # Generate nonce if not provided
        if nonce is None:
            nonce = secrets.token_hex(32)
        
        # Use nitro-tpm-attest - this is required, not optional. When a public key is
        # supplied (KMS Recipient flow), it is embedded in the attestation doc so KMS
        # can wrap the plaintext to it (CiphertextForRecipient).
        raw_attestation = generate_attestation_with_nitrotpm(
            nonce=nonce,
            user_data=user_data,
            public_key=public_key,
        )
        
        if not raw_attestation:
            raise RuntimeError(
                "nitro-tpm-attest failed to generate attestation document. "
                "Check TPM device permissions and nitro-tpm-attest installation."
            )
        
        # Validate and extract information from the attestation document
        validation_result = validate_attestation_document(raw_attestation, nonce)
        
        if not validation_result.get("verified"):
            raise RuntimeError(
                f"Attestation document validation failed: {validation_result.get('error')}"
            )
        
        attest_doc = validation_result.get("attestation_document", {})
        pcr_values = attest_doc.get("pcrs", {})
        
        # Include data hash in PCR extension if provided
        if data_hash:
            pcr_values["pcr_user_data"] = data_hash
        
        # Build full certificate chain: leaf cert + CA bundle
        full_chain = [attest_doc.get("certificate", "")]
        full_chain.extend(attest_doc.get("cabundle", []))
        
        return AttestationDocument(
            timestamp=timestamp,
            nonce=nonce,
            pcr_values=pcr_values,
            signature=base64.b64encode(raw_attestation).decode()[:100] + "...",
            certificate_chain=full_chain,
            enclave_info=self._get_enclave_info(attest_doc, validation_result),
            # Echo the signed user_data (e.g. the instance role ARN) so the client can bind
            # the KMS key policy to the attested principal rather than a hand-typed value.
            user_data=(user_data.decode("utf-8", "replace") if user_data else None),
            raw_attestation=base64.b64encode(raw_attestation).decode(),
            certificates=validation_result.get("certificates", []),
        )
    
    def verify_attestation(
        self,
        attestation: AttestationDocument,
        expected_pcrs: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Verify an attestation document.
        
        Args:
            attestation: The attestation document to verify
            expected_pcrs: Optional expected PCR values to check
            
        Returns:
            Dict with verification result and details
        """
        try:
            # If we have raw attestation data, validate it properly
            if hasattr(attestation, 'raw_attestation') and attestation.raw_attestation:
                raw_doc = base64.b64decode(attestation.raw_attestation)
                validation_result = validate_attestation_document(raw_doc, attestation.nonce)
                
                if not validation_result.get("verified"):
                    return {
                        "valid": False,
                        "message": validation_result.get("error", "Attestation validation failed"),
                    }
                
                # Verify PCR values if expected values provided
                if expected_pcrs:
                    doc_pcrs = validation_result.get("attestation_document", {}).get("pcrs", {})
                    for pcr_name, expected_value in expected_pcrs.items():
                        actual_value = doc_pcrs.get(pcr_name)
                        if actual_value != expected_value:
                            return {
                                "valid": False,
                                "message": f"PCR mismatch for {pcr_name}",
                            }
                
                return {
                    "valid": True,
                    "message": "Attestation verified successfully",
                    "enclave_info": attestation.enclave_info,
                    "cose_verified": validation_result.get("cose_verified", False),
                    "certificate_chain_verified": validation_result.get("certificate_chain_verified", False),
                    "root_verified": validation_result.get("root_verified", False),
                    "certificates": validation_result.get("certificates", []),
                }
            
            # Fallback verification for non-nitro attestations
            # Verify PCR values if expected values provided
            if expected_pcrs:
                for pcr_name, expected_value in expected_pcrs.items():
                    actual_value = attestation.pcr_values.get(pcr_name)
                    if actual_value != expected_value:
                        return {
                            "valid": False,
                            "message": f"PCR mismatch for {pcr_name}",
                        }
            
            # Check timestamp freshness (within 5 minutes)
            age = (datetime.utcnow() - attestation.timestamp).total_seconds()
            if age > 300:
                return {
                    "valid": False,
                    "message": "Attestation document expired",
                }
            
            return {
                "valid": True,
                "message": "Attestation verified successfully",
                "enclave_info": attestation.enclave_info,
            }
            
        except Exception as e:
            logger.error("Attestation verification failed", error=str(e))
            return {
                "valid": False,
                "message": f"Verification error: {str(e)}",
            }
    
    def _read_pcr_values(self) -> Dict[str, str]:
        """
        Read PCR values from TPM using tpm2-tools.
        
        PCR (Platform Configuration Register) values represent
        measurements of the system's boot and runtime state.
        """
        if self._tpm_available:
            pcrs = read_pcrs_from_tpm()
            if pcrs:
                return pcrs
        
        # If TPM read fails, return empty dict (no dummy values)
        logger.warning("Could not read PCR values from TPM")
        return {}
    
    def _sign_attestation(self, data: Dict[str, Any]) -> str:
        """
        Sign attestation data.
        
        Uses TPM for signing when available.
        """
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.backends import default_backend
        
        # Serialize data for signing
        data_bytes = json.dumps(data, sort_keys=True).encode()
        
        # Generate ephemeral key for signing
        # In production with nitro-tpm-attest, the signature comes from the TPM
        private_key = ec.generate_private_key(ec.SECP384R1(), default_backend())
        
        # Sign the data
        signature = private_key.sign(data_bytes, ec.ECDSA(hashes.SHA384()))
        
        return base64.b64encode(signature).decode()
    
    def _get_enclave_info(
        self,
        attest_doc: Optional[Dict[str, Any]] = None,
        validation_result: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Get information about the enclave environment."""
        info = {
            "enclave_type": "aws-nitro" if self._tpm_available else "none",
            "version": "1.0.0",
            "application": "boltz-protein-folding",
            "capabilities": [
                "protein_structure_prediction",
                "secure_key_management",
                "hardware_attestation",
            ],
            "memory_encrypted": self._tpm_available,
            "debug_mode": not self._tpm_available,
            "tpm_available": self._tpm_available,
            "nitro_tpm_attest_available": self._nitro_tpm_available,
        }
        
        # Add attestation document info if provided
        if attest_doc:
            info["module_id"] = attest_doc.get("module_id", "Unknown")
            info["digest"] = attest_doc.get("digest", "SHA384")
        
        # NOTE: the backend does NOT report cose_verified / certificate_chain_verified /
        # root_verified. A service verifying its own attestation is no evidence — an instance
        # that lies about its PCRs would also report verified=true. The relying party (the
        # browser) verifies the signed document itself against the pinned AWS Nitro root
        # (frontend services/attestationVerifier.ts). These fields were removed on purpose.

        # Fetch EC2 IAM role ARN from IMDS
        iam_role_arn = self._get_ec2_iam_role_arn()
        if iam_role_arn:
            info["iam_role_arn"] = iam_role_arn
        
        return info
    
    def _get_ec2_iam_role_arn(self) -> Optional[str]:
        """Fetch the IAM role ARN attached to this EC2 instance from IMDS v2."""
        import requests
        
        # The EC2 Instance Metadata Service (IMDS) is only reachable over plain HTTP at
        # the link-local address 169.254.169.254; it has no HTTPS endpoint, so the
        # http:// scheme here is required and cannot be upgraded to TLS. The requests
        # never leave the instance. raise_for_status() is called on each response so a
        # non-2xx reply surfaces as an error instead of being parsed as a valid value.
        try:
            # Get IMDS token (v2)
            token_response = requests.put(
                "http://169.254.169.254/latest/api/token",  # nosemgrep: request-with-http
                headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
                timeout=2
            )
            token_response.raise_for_status()
            token = token_response.text

            # Get instance identity document
            identity_response = requests.get(
                "http://169.254.169.254/latest/dynamic/instance-identity/document",  # nosemgrep: request-with-http
                headers={"X-aws-ec2-metadata-token": token},
                timeout=2
            )
            identity_response.raise_for_status()
            identity = identity_response.json()
            account_id = identity.get("accountId")
            region = identity.get("region")

            # Get IAM role name from instance profile
            role_response = requests.get(
                "http://169.254.169.254/latest/meta-data/iam/security-credentials/",  # nosemgrep: request-with-http
                headers={"X-aws-ec2-metadata-token": token},
                timeout=2
            )
            role_response.raise_for_status()
            role_name = role_response.text.strip()
            
            if role_name and account_id:
                return f"arn:aws:iam::{account_id}:role/{role_name}"
            
        except Exception as e:
            logger.debug("Could not fetch IAM role ARN from IMDS", error=str(e))
        
        return None
    
    def extend_pcr(self, pcr_index: int, data: bytes) -> bool:
        """
        Extend a PCR with additional data.
        
        This is used to record runtime events in the PCR values.
        
        Args:
            pcr_index: PCR index to extend (0-23)
            data: Data to extend into the PCR
            
        Returns:
            True if successful
        """
        if not self._tpm_available:
            logger.warning("Cannot extend PCR - TPM not available")
            return False
        
        return tpm_extend_pcr(pcr_index, data)