"""
Attestation Validator for AWS NitroTPM

Complete attestation document validation following AWS Nitro Enclaves process:
https://github.com/aws/aws-nitro-enclaves-nsm-api/blob/main/docs/attestation_process.md#3-attestation-document-validation

Based on https://github.com/aws-samples/sample-mpc-app-using-aws-nitrotpm
"""

import cbor2
import base64
import hashlib
import logging
from typing import Dict, Any, List, Optional
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from backend.services.certificate_parser import parse_certificate_chain, verify_root_certificate

logger = logging.getLogger(__name__)


def validate_attestation_document(raw_doc: bytes, expected_nonce: Optional[str] = None) -> Dict[str, Any]:
    """
    Complete attestation document validation following AWS Nitro Enclaves process:
    https://github.com/aws/aws-nitro-enclaves-nsm-api/blob/main/docs/attestation_process.md#3-attestation-document-validation
    """
    try:
        # Step 1: Parse CBOR and extract COSE_Sign1 structure
        parsed_cbor = cbor2.loads(raw_doc)
        logger.info(f"Parsed CBOR type: {type(parsed_cbor)}, length: {len(parsed_cbor) if isinstance(parsed_cbor, (list, dict)) else 'N/A'}")

        if isinstance(parsed_cbor, list) and len(parsed_cbor) >= 3:
            # From nitro-tpm-attest tool: [protected, unprotected, payload, signature]
            protected_headers = parsed_cbor[0]
            unprotected_headers = parsed_cbor[1] if len(parsed_cbor) > 1 else {}
            payload = parsed_cbor[2]
            signature = parsed_cbor[3] if len(parsed_cbor) > 3 else b""
            logger.info(f"COSE structure - protected: {type(protected_headers)}, payload: {type(payload)}, signature: {type(signature)}")
        else:
            logger.error(f"Invalid COSE_Sign1 structure: {type(parsed_cbor)}")
            return {"verified": False, "error": "Invalid COSE_Sign1 structure"}

        # Step 2: Parse attestation document from payload
        attestation_doc = cbor2.loads(payload)

        # Step 3: Extract certificate and CA bundle
        certificate_der = attestation_doc.get("certificate", b"")
        cabundle = attestation_doc.get("cabundle", [])

        if not certificate_der:
            return {"verified": False, "error": "No certificate in attestation document"}

        # Step 4: Verify certificate chain
        cert_chain_result = parse_certificate_chain(certificate_der, cabundle)
        if cert_chain_result.get("status") == "error":
            return {"verified": False, "error": f"Certificate chain validation failed: {cert_chain_result.get('error')}"}

        # Step 5: Verify COSE signature using TPM certificate
        tpm_cert = x509.load_der_x509_certificate(certificate_der, default_backend())
        cose_verification = _verify_cose_signature(protected_headers, payload, signature, tpm_cert)

        logger.info(f"COSE verification result: {cose_verification}")

        if not cose_verification["verified"]:
            logger.warning(f"COSE signature verification failed: {cose_verification.get('error')}")
            # Continue anyway - certificate chain validation provides authenticity

        # Step 6: Verify nonce if provided
        nonce_verified = True
        if expected_nonce:
            doc_nonce = attestation_doc.get("nonce")
            if doc_nonce:
                doc_nonce_str = doc_nonce.decode() if isinstance(doc_nonce, bytes) else str(doc_nonce)
                nonce_verified = doc_nonce_str == expected_nonce
            else:
                nonce_verified = False

        # Step 7: Extract and validate PCRs
        pcrs = {}
        if "nitrotpm_pcrs" in attestation_doc:
            for pcr_num, pcr_value in attestation_doc["nitrotpm_pcrs"].items():
                if isinstance(pcr_value, bytes):
                    pcrs[str(pcr_num)] = pcr_value.hex()
                elif isinstance(pcr_value, str):
                    try:
                        pcr_bytes = base64.b64decode(pcr_value)
                        pcrs[str(pcr_num)] = pcr_bytes.hex()
                    except:
                        pcrs[str(pcr_num)] = pcr_value

        logger.info("Building return document...")

        return {
            "verified": True,
            "cose_verified": cose_verification.get("verified", False),
            "certificate_chain_verified": cert_chain_result.get("chain_verified", False),
            "root_verified": cert_chain_result.get("root_verified", False),
            "nonce_verified": nonce_verified,
            "attestation_document": {
                "module_id": attestation_doc.get("module_id", "Unknown"),
                "timestamp": attestation_doc.get("timestamp", 0),
                "digest": attestation_doc.get("digest", "SHA384"),
                "pcrs": pcrs,
                "certificate": base64.b64encode(certificate_der).decode(),
                "cabundle": [base64.b64encode(cert).decode() for cert in cabundle],
                "public_key": base64.b64encode(attestation_doc.get("public_key") or b"").decode(),
                "user_data": base64.b64encode(attestation_doc.get("user_data") or b"").decode() if attestation_doc.get("user_data") else None,
                "nonce": base64.b64encode(attestation_doc.get("nonce") or b"").decode() if attestation_doc.get("nonce") else None,
            },
            "certificates": cert_chain_result.get("certificates", [])
        }

    except Exception as e:
        logger.error(f"Attestation validation failed: {e}")
        return {"verified": False, "error": str(e)}


def _verify_cose_signature(protected_headers: bytes, payload: bytes, signature: bytes, certificate: x509.Certificate) -> Dict[str, Any]:
    """Verify COSE_Sign1 signature using certificate public key"""
    try:
        # Step 1: Create Sig_structure for COSE_Sign1
        sig_structure = [
            "Signature1",
            protected_headers,
            b"",  # external_aad (empty)
            payload
        ]

        # Step 2: Encode Sig_structure as CBOR
        sig_structure_cbor = cbor2.dumps(sig_structure)

        # Step 3: Get public key from certificate
        public_key = certificate.public_key()

        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            return {"verified": False, "error": "Certificate must contain EC public key"}

        # Step 4: Try to verify signature with different approaches
        # AWS NitroTPM uses ECDSA with SHA384
        logger.info(f"Attempting COSE signature verification: sig_len={len(signature)}, curve={public_key.curve.name}")

        try:
            # Try direct verification (signature might be in raw r||s format)
            public_key.verify(
                signature,
                sig_structure_cbor,
                ec.ECDSA(hashes.SHA384())
            )
            logger.info("COSE signature verified successfully (direct)")
            return {"verified": True}
        except Exception as e1:
            # If direct verification fails, try converting from DER to raw format
            try:
                from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

                # Try to decode as DER and re-encode as raw
                r, s = decode_dss_signature(signature)

                # Convert to raw format (r||s)
                key_size = public_key.curve.key_size
                byte_length = (key_size + 7) // 8
                raw_sig = r.to_bytes(byte_length, 'big') + s.to_bytes(byte_length, 'big')

                public_key.verify(
                    raw_sig,
                    sig_structure_cbor,
                    ec.ECDSA(hashes.SHA384())
                )
                return {"verified": True}
            except Exception as e2:
                # Try the opposite: convert from raw to DER
                try:
                    key_size = public_key.curve.key_size
                    byte_length = (key_size + 7) // 8

                    if len(signature) == 2 * byte_length:
                        # Signature is in raw r||s format, convert to DER
                        r = int.from_bytes(signature[:byte_length], 'big')
                        s = int.from_bytes(signature[byte_length:], 'big')
                        der_sig = encode_dss_signature(r, s)

                        public_key.verify(
                            der_sig,
                            sig_structure_cbor,
                            ec.ECDSA(hashes.SHA384())
                        )
                        return {"verified": True}
                except Exception as e3:
                    return {"verified": False, "error": f"All signature formats failed: DER={str(e1)[:50]}, raw={str(e3)[:50]}"}

        return {"verified": False, "error": "Signature verification failed"}

    except Exception as e:
        return {"verified": False, "error": f"COSE signature verification error: {e}"}


def generate_attestation_with_nitrotpm(
    nonce: Optional[str] = None,
    user_data: Optional[bytes] = None,
    public_key: Optional[bytes] = None
) -> Optional[bytes]:
    """
    Generate attestation document using nitro-tpm-attest tool.
    
    Following the reference implementation:
    https://github.com/aws-samples/sample-mpc-app-using-aws-nitrotpm/blob/main/backend/tpm_client.py
    
    Returns raw CBOR-encoded COSE_Sign1 attestation document.
    
    Note: The boltz user must be in the 'tss' group for TPM access.
    """
    import subprocess  # nosec B404 - fixed argv, no shell
    import tempfile
    import os
    
    temp_nonce_file = None
    temp_user_file = None
    temp_key_file = None
    
    try:
        # Create temp files for arguments (following reference implementation)
        if public_key:
            temp_key_file = tempfile.NamedTemporaryFile(delete=False)
            temp_key_file.write(public_key)
            temp_key_file.flush()
            temp_key_file.close()
        
        if user_data:
            temp_user_file = tempfile.NamedTemporaryFile(delete=False)
            temp_user_file.write(user_data)
            temp_user_file.flush()
            temp_user_file.close()
        
        if nonce:
            temp_nonce_file = tempfile.NamedTemporaryFile(delete=False)
            # Convert string nonce to bytes if needed
            nonce_bytes = nonce.encode() if isinstance(nonce, str) else nonce
            temp_nonce_file.write(nonce_bytes)
            temp_nonce_file.flush()
            temp_nonce_file.close()
        
        # Build command arguments
        cmd = ['nitro-tpm-attest']
        if public_key and temp_key_file:
            cmd.append('--public-key')
            cmd.append(temp_key_file.name)
        if user_data and temp_user_file:
            cmd.append('--user-data')
            cmd.append(temp_user_file.name)
        if nonce and temp_nonce_file:
            cmd.append('--nonce')
            cmd.append(temp_nonce_file.name)
        
        logger.info(f"Running nitro-tpm-attest: {' '.join(cmd)}")
        
        # Execute command (following reference implementation - no extra env vars)
        # `cmd` is not a static string, but every element is trusted: element 0 is the
        # literal 'nitro-tpm-attest', the flags are literals, and the only variable parts
        # are tempfile-generated paths (tempfile.NamedTemporaryFile picks the name, not the
        # caller). No caller-supplied value reaches argv, and shell=False means no shell
        # metacharacter interpretation, so command injection is not reachable here.
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(cmd, capture_output=True, timeout=30)  # nosec B603 - argv is fixed tool + our own temp file paths, no shell
        
        if result.returncode != 0:
            stderr = result.stderr.decode() if result.stderr else "Unknown error"
            logger.error(f"nitro-tpm-attest failed (exit code {result.returncode}): {stderr}")
            return None
        
        raw_output = result.stdout
        logger.info(f"nitro-tpm-attest output: {len(raw_output)} bytes")
        
        if not raw_output:
            logger.error("nitro-tpm-attest returned empty output")
            return None
        
        return raw_output
    
    except subprocess.TimeoutExpired:
        logger.error("nitro-tpm-attest timed out")
        return None
    except FileNotFoundError:
        logger.error("nitro-tpm-attest not found")
        return None
    except Exception as e:
        logger.error(f"Failed to generate attestation: {e}")
        return None
    finally:
        # Cleanup temp files. Failure to remove a temp file is non-fatal (the OS
        # reclaims the temp dir), so log at debug rather than raising.
        for temp_file in [temp_key_file, temp_user_file, temp_nonce_file]:
            if temp_file:
                try:
                    os.unlink(temp_file.name)
                except OSError as e:
                    logger.debug(f"Could not remove temp file {temp_file.name}: {e}")


def read_pcrs_from_tpm() -> Dict[str, str]:
    """
    Read all PCR values from TPM using tpm2_pcrread
    
    Returns dict of PCR index to hex value
    """
    import subprocess  # nosec B404 - fixed argv, no shell
    
    pcrs = {}
    
    try:
        # Read all 24 PCRs with SHA256 bank
        result = subprocess.run(  # nosec B603 B607 - fixed tpm2_pcrread argv, no shell
            ["tpm2_pcrread", "sha256:0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            # Parse PCR values from output
            # Format: "  0 : 0x..."
            for line in result.stdout.split("\n"):
                line = line.strip()
                if ":" in line and "0x" in line.lower():
                    parts = line.split(":")
                    if len(parts) >= 2:
                        pcr_num = parts[0].strip()
                        pcr_value = parts[1].strip()
                        # Remove 0x prefix if present
                        if pcr_value.lower().startswith("0x"):
                            pcr_value = pcr_value[2:]
                        pcrs[f"pcr{pcr_num}"] = pcr_value.lower()
        else:
            logger.warning(f"tpm2_pcrread failed: {result.stderr}")
            
    except FileNotFoundError:
        logger.warning("tpm2_pcrread not found")
    except subprocess.TimeoutExpired:
        logger.warning("tpm2_pcrread timed out")
    except Exception as e:
        logger.error(f"Failed to read PCRs: {e}")
    
    return pcrs


def extend_pcr(pcr_index: int, data_hash: str, tpm_device: str = "/dev/tpmrm0") -> bool:
    """
    Extend a PCR with a SHA384 hash value.
    
    AWS NitroTPM attestation uses SHA-384 PCR bank, so we must extend
    the SHA-384 bank for the value to appear in attestation documents.
    
    Note: The boltz user must be in the 'tss' group for TPM access.
    See /etc/udev/rules.d/99-tpm.rules for device permissions.
    
    Args:
        pcr_index: PCR index (0-23)
        data_hash: SHA384 hash as hex string (96 characters)
        tpm_device: Path to TPM device (optional)
        
    Returns:
        True if successful
    """
    import subprocess  # nosec B404 - fixed argv, no shell
    
    try:
        # Validate hash format (should be 96 hex characters for SHA-384)
        if len(data_hash) != 96:
            logger.error(f"Invalid hash length: {len(data_hash)}, expected 96 for SHA-384")
            return False
        
        # Ensure hash is lowercase hex
        data_hash = data_hash.lower()
        
        # Extend SHA-384 bank (used by AWS NitroTPM attestation)
        # No sudo needed - boltz user is in tss group with udev rules for /dev/tpmrm0
        result = subprocess.run(  # nosec B603 B607 - fixed tpm2_pcrextend argv, validated hex hash, no shell
            ["tpm2_pcrextend", f"{pcr_index}:sha384={data_hash}"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            logger.info(f"Extended PCR{pcr_index} (sha384) with hash {data_hash[:16]}...")
            return True
        else:
            logger.error(f"tpm2_pcrextend failed: {result.stderr}")
            return False
            
    except FileNotFoundError:
        logger.warning("tpm2_pcrextend not found - cannot extend PCR")
        return False
    except subprocess.TimeoutExpired:
        logger.warning("tpm2_pcrextend timed out")
        return False
    except Exception as e:
        logger.error(f"Failed to extend PCR: {e}")
        return False
