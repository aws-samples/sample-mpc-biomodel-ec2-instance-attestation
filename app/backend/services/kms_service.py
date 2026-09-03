"""
KMS Service for Attestation-Based Decryption

Implements decryption of data using AWS KMS with attestation documents
to prove that decryption is occurring on a trusted platform.

Based on https://github.com/aws-samples/sample-mpc-app-using-aws-nitrotpm
"""

import base64
import json
import os
import struct
import subprocess  # nosec B404 - used only with fixed argv, no shell
import tempfile
from pathlib import Path
from typing import Optional, Dict, Any, Tuple, Callable

import boto3
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
import structlog

from backend.services.attestation import AttestationService

# Encryption context enforced on the model KMS key (must match the model-update
# workflow's GenerateDataKey call in cdk model-workflow.ts).
MODEL_ENCRYPTION_CONTEXT = {"application": "boltz-protein-folding"}

# Streaming read size for GCM decrypt (matches the 64 MiB producer chunks; any
# size works since GCM is a stream cipher, but keep memory bounded for GB files).
_DECRYPT_CHUNK = 64 * 1024 * 1024
_GCM_TAG_LEN = 16
_GCM_NONCE_LEN = 12

logger = structlog.get_logger()


class KMSDecryptionError(Exception):
    """Exception raised when KMS decryption fails."""
    pass


def _generate_rsa_keypair() -> Tuple[bytes, bytes]:
    """
    Generate an ephemeral RSA key pair for the KMS Recipient flow.

    Returns (private_key_pem, public_key_der). The DER public key is embedded in the
    attestation document; the PEM private key unwraps the CMS envelope KMS returns.
    Uses openssl (baked into the AMI) to match the nitro-tpm-attest CLI expectations.
    """
    priv = subprocess.run(['openssl', 'genrsa', '2048'], capture_output=True, timeout=30)  # nosec B603 B607 - fixed argv, no shell, no external input
    if priv.returncode != 0:
        raise KMSDecryptionError(f"RSA private key generation failed: {priv.stderr.decode()}")
    private_key_pem = priv.stdout

    pub = subprocess.run(  # nosec B603 B607 - fixed argv, no shell, no external input
        ['openssl', 'rsa', '-pubout', '-outform', 'DER'],
        input=private_key_pem, capture_output=True, timeout=30,
    )
    if pub.returncode != 0:
        raise KMSDecryptionError(f"RSA public key export failed: {pub.stderr.decode()}")
    return private_key_pem, pub.stdout


def _cms_decrypt(ciphertext_for_recipient, private_key_pem: bytes) -> bytes:
    """
    Unwrap the CiphertextForRecipient (a CMS/PKCS7 envelope, DER-encoded) that KMS
    returns when a Recipient attestation is supplied, using the matching RSA private
    key. Returns the recovered plaintext (the original data key / sequence bytes).
    """
    cms_data = (
        base64.b64decode(ciphertext_for_recipient)
        if isinstance(ciphertext_for_recipient, str)
        else ciphertext_for_recipient
    )

    priv_path = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', delete=False) as f:
            f.write(private_key_pem)
            f.flush()  # ensure the key is on disk before openssl reads it by path
            os.fsync(f.fileno())
            priv_path = f.name
        result = subprocess.run(  # nosec B603 B607 - fixed 'openssl' argv, no shell; inputs are our own temp path
            ['openssl', 'cms', '-decrypt', '-inform', 'DER', '-inkey', priv_path],
            input=cms_data, capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise KMSDecryptionError(f"CMS decrypt failed: {result.stderr.decode()}")
        if not result.stdout:
            raise KMSDecryptionError("CMS decrypt returned empty plaintext")
        return result.stdout
    finally:
        if priv_path:
            try:
                os.unlink(priv_path)
            except OSError:
                pass


class AttestationRequiredError(KMSDecryptionError):
    """Exception raised when attestation is required but not available."""
    pass


class KMSService:
    """
    Service for decrypting data using AWS KMS with attestation.
    
    This service allows the backend to decrypt data that was encrypted
    by the frontend using KMS, but only when the backend can provide
    a valid attestation document proving platform integrity.
    
    The attestation document is passed to KMS in the Recipient field,
    and KMS will only decrypt if the attestation is valid and matches
    the key policy conditions.
    """
    
    def __init__(
        self,
        attestation_service: Optional[AttestationService] = None,
        region: Optional[str] = None,
    ):
        """
        Initialize the KMS service.
        
        Args:
            attestation_service: Optional attestation service instance.
                                If not provided, a new one will be created.
            region: AWS region for KMS. Defaults to environment/instance region.
        """
        self.attestation_service = attestation_service or AttestationService()
        self.region = region
        self._kms_client = None
        
    @property
    def kms_client(self):
        """Lazy-initialize KMS client."""
        if self._kms_client is None:
            if self.region:
                self._kms_client = boto3.client('kms', region_name=self.region)
            else:
                self._kms_client = boto3.client('kms')
        return self._kms_client
    
    def decrypt_with_attestation(
        self,
        ciphertext_blob: bytes,
        encryption_context: Optional[Dict[str, str]] = None,
        nonce: Optional[str] = None,
        key_id: Optional[str] = None,
    ) -> bytes:
        """
        Decrypt data using KMS with attestation.
        
        This method:
        1. Generates a fresh attestation document (optionally with the provided nonce)
        2. Sends the attestation document to KMS in the Recipient field
        3. KMS validates the attestation and only decrypts if valid
        4. Returns the decrypted plaintext
        
        Args:
            ciphertext_blob: The encrypted data from KMS Encrypt
            encryption_context: Optional encryption context that was used during encryption
            nonce: Optional nonce to include in attestation for freshness
            key_id: Optional KMS key ID (required if ciphertext doesn't include key info)
            
        Returns:
            Decrypted plaintext bytes
            
        Raises:
            AttestationRequiredError: If attestation is not available
            KMSDecryptionError: If decryption fails
        """
        # Check if attestation is available
        if not self.attestation_service.is_available():
            raise AttestationRequiredError(
                "Attestation service not available. Cannot decrypt without attestation."
            )

        logger.info(
            "Attempting KMS decrypt with attestation",
            has_nonce=nonce is not None,
            has_encryption_context=encryption_context is not None,
            key_id=key_id,
        )

        try:
            # The KMS Recipient flow requires an ephemeral RSA key pair: the PUBLIC key
            # is embedded in the attestation document, KMS validates the attestation and
            # returns the plaintext wrapped (CMS/PKCS7) to that public key, which we
            # unwrap with the PRIVATE key. (Matches sample-mpc-app-using-aws-nitrotpm.)
            # Kept inside the try so keypair/attestation failures surface as a structured
            # KMSDecryptionError (readable 400) rather than an opaque 500.
            private_key_pem, public_key_der = _generate_rsa_keypair()

            attestation_doc = self.attestation_service.generate_attestation(
                nonce=nonce, public_key=public_key_der
            )

            if not attestation_doc.raw_attestation:
                raise KMSDecryptionError("Attestation document is empty; cannot build Recipient")

            attestation_bytes = base64.b64decode(attestation_doc.raw_attestation)

            decrypt_params: Dict[str, Any] = {
                'CiphertextBlob': ciphertext_blob,
                'Recipient': {
                    'KeyEncryptionAlgorithm': 'RSAES_OAEP_SHA_256',
                    'AttestationDocument': attestation_bytes,
                },
            }
            if key_id:
                decrypt_params['KeyId'] = key_id
            if encryption_context:
                decrypt_params['EncryptionContext'] = encryption_context

            # Call KMS Decrypt (attestation in Recipient => plaintext returned wrapped).
            response = self.kms_client.decrypt(**decrypt_params)

            if 'CiphertextForRecipient' not in response:
                raise KMSDecryptionError(
                    "KMS did not return CiphertextForRecipient; the Recipient/attestation "
                    "flow did not engage"
                )

            plaintext = _cms_decrypt(response['CiphertextForRecipient'], private_key_pem)
            logger.info("KMS decrypt with attestation successful")
            return plaintext

        except ClientError as e:
            error_code = e.response['Error']['Code']
            error_message = e.response['Error']['Message']
            
            logger.error(
                "KMS decrypt failed",
                error_code=error_code,
                error_message=error_message,
            )
            
            if error_code == 'InvalidCiphertextException':
                raise KMSDecryptionError(
                    "Invalid ciphertext. The data may be corrupted or was encrypted with a different key."
                )
            elif error_code == 'AccessDeniedException':
                raise KMSDecryptionError(
                    "Access denied. The key policy may not allow decryption with this attestation."
                )
            elif error_code == 'KMSInvalidStateException':
                raise KMSDecryptionError(
                    "KMS key is not in a valid state for decryption."
                )
            else:
                raise KMSDecryptionError(f"KMS decryption failed: {error_message}")
                
        except Exception as e:
            logger.error("Unexpected error during KMS decrypt", error=str(e))
            raise KMSDecryptionError(f"Unexpected error: {str(e)}")
    
    def decrypt_model_blob_to_file(
        self,
        encrypted_blob: bytes,
        output_path: Path,
        on_stage: Optional[Callable[[str], None]] = None,
    ) -> None:
        """
        Decrypt an envelope-encrypted model weight blob to a file.

        The blob format is produced by the model-update workflow
        (cdk/lib/constructs/model-workflow.ts):

            [4-byte big-endian wrapped-key-len]
            [wrapped data key (KMS CiphertextBlob)]
            [12-byte GCM nonce]
            [ciphertext ...]
            [16-byte GCM tag]   (last 16 bytes)

        The wrapped data key was produced by kms:GenerateDataKey on
        alias/boltz-model-key with encryption context application=boltz-protein-folding,
        so we kms:Decrypt it with the SAME context to recover the AES-256 key, then
        AES-256-GCM-decrypt the ciphertext.

        Args:
            encrypted_blob: The full .enc object bytes.
            output_path: Where to write the decrypted weight file.

        Raises:
            KMSDecryptionError: on any parse/KMS/AES failure.
        """
        try:
            if len(encrypted_blob) < 4:
                raise KMSDecryptionError("Encrypted blob too short (no header)")
            # encrypted_blob may be bytes or a bytearray (the reload path streams into a
            # bytearray to report download progress). Convert the small header fields to
            # bytes so KMS/cryptography receive plain bytes; the large ciphertext is left
            # as a slice and wrapped in a memoryview below.
            (wrapped_len,) = struct.unpack(">I", bytes(encrypted_blob[:4]))
            off = 4
            wrapped_key = bytes(encrypted_blob[off:off + wrapped_len])
            off += wrapped_len
            nonce = bytes(encrypted_blob[off:off + _GCM_NONCE_LEN])
            off += _GCM_NONCE_LEN
            if len(encrypted_blob) < off + _GCM_TAG_LEN:
                raise KMSDecryptionError("Encrypted blob too short (no ciphertext/tag)")
            ciphertext = encrypted_blob[off:-_GCM_TAG_LEN]
            tag = bytes(encrypted_blob[-_GCM_TAG_LEN:])

            # Unwrap the AES data key via KMS UNDER ATTESTATION. The model key policy is
            # PCR-gated, so the wrapped data key must be recovered through the Recipient
            # flow (ephemeral public key in the attestation document -> KMS returns
            # CiphertextForRecipient -> unwrap locally), the same path the sequence decrypt
            # uses. A plain kms:Decrypt here would carry no attestation, so an
            # attestation-gated key could not evaluate the PCR conditions against it.
            # This is the step that fails (AccessDenied) when the PCRs do not match the
            # key policy, so surface it as its own stage for progress/diagnostics.
            if on_stage:
                on_stage("data-key")
            data_key = self.decrypt_with_attestation(
                wrapped_key,
                encryption_context=MODEL_ENCRYPTION_CONTEXT,
            )

            # AES-256-GCM decrypt (streaming), verifying the tag on finalize().
            if on_stage:
                on_stage("blob")
            decryptor = Cipher(algorithms.AES(data_key), modes.GCM(nonce, tag)).decryptor()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "wb") as fout:
                view = memoryview(ciphertext)
                for i in range(0, len(view), _DECRYPT_CHUNK):
                    fout.write(decryptor.update(view[i:i + _DECRYPT_CHUNK]))
                fout.write(decryptor.finalize())  # raises InvalidTag if corrupted/wrong key
            del data_key
            logger.info("Model weight decrypted", output=str(output_path), bytes=len(ciphertext))
        except ClientError as e:
            code = e.response["Error"]["Code"]
            msg = e.response["Error"]["Message"]
            logger.error("KMS decrypt of model data key failed", error_code=code, error_message=msg)
            raise KMSDecryptionError(f"KMS decrypt failed ({code}): {msg}")
        except KMSDecryptionError:
            raise
        except Exception as e:
            logger.error("Model blob decryption failed", error=str(e))
            raise KMSDecryptionError(f"Model blob decryption failed: {e}")

    def decrypt_sequence(
        self,
        encrypted_data: str,
        s3_key: str,
        encryption_context: Optional[Dict[str, str]] = None,
    ) -> str:
        """
        Decrypt an encrypted protein sequence.
        
        This is a convenience method for the predict endpoint to decrypt
        sequences that were encrypted by the frontend.
        
        Args:
            encrypted_data: Base64-encoded encrypted sequence data
            s3_key: The S3 key where the encrypted data is stored (for logging)
            encryption_context: Optional encryption context
            
        Returns:
            Decrypted sequence string
        """
        logger.info("Decrypting sequence", s3_key=s3_key)
        
        # Decode the base64 encrypted data
        ciphertext_blob = base64.b64decode(encrypted_data)
        
        # Decrypt with attestation
        plaintext_bytes = self.decrypt_with_attestation(
            ciphertext_blob=ciphertext_blob,
            encryption_context=encryption_context,
        )
        
        # Decode the plaintext to string
        sequence = plaintext_bytes.decode('utf-8')
        
        logger.info(
            "Sequence decrypted successfully",
            s3_key=s3_key,
            sequence_length=len(sequence),
        )
        
        return sequence


# Singleton instance for use across the application
_kms_service: Optional[KMSService] = None


def get_kms_service() -> KMSService:
    """Get the global KMS service instance."""
    global _kms_service
    if _kms_service is None:
        _kms_service = KMSService()
    return _kms_service


def decrypt_with_attestation(
    ciphertext_blob: bytes,
    encryption_context: Optional[Dict[str, str]] = None,
    nonce: Optional[str] = None,
) -> bytes:
    """
    Convenience function to decrypt data with attestation.
    
    This is a module-level function that uses the singleton KMS service.
    """
    return get_kms_service().decrypt_with_attestation(
        ciphertext_blob=ciphertext_blob,
        encryption_context=encryption_context,
        nonce=nonce,
    )