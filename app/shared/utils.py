"""
Shared utility functions for the Boltz Protein Folding application.
"""

import hashlib
import re
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any

from shared.constants import (
    VALID_PROTEIN_CHARS,
    VALID_DNA_CHARS,
    VALID_RNA_CHARS,
    AA_THREE_LETTER,
)


def generate_job_id() -> str:
    """Generate a unique job identifier."""
    return str(uuid.uuid4())


def clean_sequence(sequence: str) -> str:
    """
    Clean a biological sequence by removing whitespace and converting to uppercase.
    
    Args:
        sequence: Raw sequence string
        
    Returns:
        Cleaned sequence string
    """
    return re.sub(r'\s+', '', sequence.upper())


def validate_protein_sequence(sequence: str) -> tuple[bool, Optional[str]]:
    """
    Validate a protein sequence.
    
    Args:
        sequence: Protein sequence to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    cleaned = clean_sequence(sequence)
    
    if not cleaned:
        return False, "Sequence is empty"
    
    invalid_chars = set(cleaned) - VALID_PROTEIN_CHARS
    if invalid_chars:
        return False, f"Invalid amino acid characters: {', '.join(sorted(invalid_chars))}"
    
    return True, None


def validate_dna_sequence(sequence: str) -> tuple[bool, Optional[str]]:
    """
    Validate a DNA sequence.
    
    Args:
        sequence: DNA sequence to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    cleaned = clean_sequence(sequence)
    
    if not cleaned:
        return False, "Sequence is empty"
    
    invalid_chars = set(cleaned) - VALID_DNA_CHARS
    if invalid_chars:
        return False, f"Invalid DNA characters: {', '.join(sorted(invalid_chars))}"
    
    return True, None


def validate_rna_sequence(sequence: str) -> tuple[bool, Optional[str]]:
    """
    Validate an RNA sequence.
    
    Args:
        sequence: RNA sequence to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    cleaned = clean_sequence(sequence)
    
    if not cleaned:
        return False, "Sequence is empty"
    
    invalid_chars = set(cleaned) - VALID_RNA_CHARS
    if invalid_chars:
        return False, f"Invalid RNA characters: {', '.join(sorted(invalid_chars))}"
    
    return True, None


def sequence_to_three_letter(sequence: str) -> List[str]:
    """
    Convert a single-letter amino acid sequence to three-letter codes.
    
    Args:
        sequence: Single-letter sequence
        
    Returns:
        List of three-letter codes
    """
    return [AA_THREE_LETTER.get(aa, 'UNK') for aa in clean_sequence(sequence)]


def calculate_sequence_hash(sequence: str) -> str:
    """
    Calculate SHA-256 hash of a sequence.
    
    Args:
        sequence: Sequence to hash
        
    Returns:
        Hexadecimal hash string
    """
    cleaned = clean_sequence(sequence)
    return hashlib.sha256(cleaned.encode()).hexdigest()


def calculate_data_hash(data: Dict[str, Any]) -> str:
    """
    Calculate SHA-256 hash of a dictionary.
    
    Args:
        data: Dictionary to hash
        
    Returns:
        Hexadecimal hash string
    """
    import json
    data_str = json.dumps(data, sort_keys=True)
    return hashlib.sha256(data_str.encode()).hexdigest()


def format_timestamp(dt: datetime) -> str:
    """
    Format a datetime object as ISO 8601 string.
    
    Args:
        dt: Datetime object
        
    Returns:
        ISO 8601 formatted string
    """
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_timestamp(timestamp_str: str) -> datetime:
    """
    Parse an ISO 8601 timestamp string.
    
    Args:
        timestamp_str: ISO 8601 formatted string
        
    Returns:
        Datetime object
    """
    # Handle various ISO 8601 formats
    formats = [
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(timestamp_str, fmt)
        except ValueError:
            continue
    
    raise ValueError(f"Unable to parse timestamp: {timestamp_str}")


def estimate_processing_time(sequence_length: int) -> int:
    """
    Estimate processing time for a protein folding prediction.
    
    Args:
        sequence_length: Length of the sequence
        
    Returns:
        Estimated time in seconds
    """
    # Base time + time proportional to sequence length
    # Longer sequences take quadratically longer due to attention mechanisms
    base_time = 30
    linear_factor = sequence_length // 10
    quadratic_factor = (sequence_length ** 2) // 10000
    
    return base_time + linear_factor + quadratic_factor


def truncate_string(s: str, max_length: int = 50, suffix: str = "...") -> str:
    """
    Truncate a string to a maximum length.
    
    Args:
        s: String to truncate
        max_length: Maximum length
        suffix: Suffix to add if truncated
        
    Returns:
        Truncated string
    """
    if len(s) <= max_length:
        return s
    return s[:max_length - len(suffix)] + suffix


def format_file_size(size_bytes: int) -> str:
    """
    Format a file size in human-readable format.
    
    Args:
        size_bytes: Size in bytes
        
    Returns:
        Human-readable size string
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def safe_json_loads(json_str: str, default: Any = None) -> Any:
    """
    Safely parse JSON string, returning default on error.
    
    Args:
        json_str: JSON string to parse
        default: Default value if parsing fails
        
    Returns:
        Parsed object or default
    """
    import json
    try:
        return json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return default