"""
Shared constants for the Boltz Protein Folding application.
"""

# Application metadata
APP_NAME = "boltz-protein-folding"
APP_VERSION = "1.0.0"
APP_DESCRIPTION = "Secure protein structure prediction with hardware attestation"

# Amino acid codes
AMINO_ACIDS = {
    'A': 'Alanine',
    'C': 'Cysteine',
    'D': 'Aspartic acid',
    'E': 'Glutamic acid',
    'F': 'Phenylalanine',
    'G': 'Glycine',
    'H': 'Histidine',
    'I': 'Isoleucine',
    'K': 'Lysine',
    'L': 'Leucine',
    'M': 'Methionine',
    'N': 'Asparagine',
    'P': 'Proline',
    'Q': 'Glutamine',
    'R': 'Arginine',
    'S': 'Serine',
    'T': 'Threonine',
    'V': 'Valine',
    'W': 'Tryptophan',
    'Y': 'Tyrosine',
}

# Three-letter amino acid codes
AA_THREE_LETTER = {
    'A': 'ALA', 'C': 'CYS', 'D': 'ASP', 'E': 'GLU', 'F': 'PHE',
    'G': 'GLY', 'H': 'HIS', 'I': 'ILE', 'K': 'LYS', 'L': 'LEU',
    'M': 'MET', 'N': 'ASN', 'P': 'PRO', 'Q': 'GLN', 'R': 'ARG',
    'S': 'SER', 'T': 'THR', 'V': 'VAL', 'W': 'TRP', 'Y': 'TYR',
    'X': 'UNK', 'B': 'ASX', 'Z': 'GLX', 'J': 'XLE', 'U': 'SEC',
    'O': 'PYL', '*': 'TER', '-': 'GAP',
}

# Valid sequence characters
VALID_PROTEIN_CHARS = set("ACDEFGHIKLMNPQRSTVWYBXZJUO*-")
VALID_DNA_CHARS = set("ACGTNRYSWKMBDHV-")
VALID_RNA_CHARS = set("ACGUNRYSWKMBDHV-")

# Sequence limits
MIN_SEQUENCE_LENGTH = 10
MAX_SEQUENCE_LENGTH = 2048

# Job status constants
JOB_STATUS_PENDING = "pending"
JOB_STATUS_PROCESSING = "processing"
JOB_STATUS_COMPLETED = "completed"
JOB_STATUS_FAILED = "failed"

# Attestation constants
PCR_BANKS = ["sha256"]
ATTESTATION_VALIDITY_SECONDS = 300  # 5 minutes

# API endpoints
API_VERSION = "v1"
API_PREFIX = f"/api/{API_VERSION}"

# HTTP status codes
HTTP_200_OK = 200
HTTP_201_CREATED = 201
HTTP_400_BAD_REQUEST = 400
HTTP_401_UNAUTHORIZED = 401
HTTP_403_FORBIDDEN = 403
HTTP_404_NOT_FOUND = 404
HTTP_500_INTERNAL_SERVER_ERROR = 500
HTTP_503_SERVICE_UNAVAILABLE = 503