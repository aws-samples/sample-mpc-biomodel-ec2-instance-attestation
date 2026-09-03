// User types
export interface User {
  username: string
  email: string
  emailVerified: boolean
  sub: string
}

export interface AuthState {
  isAuthenticated: boolean
  isLoading: boolean
  user: User | null
  error: string | null
}

// Role types
export type UserRole = 'biologist' | 'biophysicist'

export interface RoleConfig {
  id: UserRole
  name: string
  description: string
  icon: string
  kmsKeyAlias: string
  s3BucketPrefix: string
  primaryColor: string
}

export const ROLE_CONFIGS: Record<UserRole, RoleConfig> = {
  biologist: {
    id: 'biologist',
    name: 'Computational Biologist',
    description: 'Protein structure prediction using encrypted sequences',
    icon: '🧬',
    kmsKeyAlias: 'alias/boltz-sequence-key',
    s3BucketPrefix: 'boltz-sequences',
    primaryColor: 'blue',
  },
  biophysicist: {
    id: 'biophysicist',
    name: 'Computational Biophysicist',
    description: 'Model weight updates and deployment',
    icon: '⚛️',
    kmsKeyAlias: 'alias/boltz-model-key',
    s3BucketPrefix: 'boltz-models',
    primaryColor: 'purple',
  },
}

// Attestation types
export interface EnclaveInfo {
  module_id: string
  tpm_available: boolean
  tpm_vendor?: string
  pcr_bank?: string
  debug_mode: boolean
  memory_encrypted: boolean
  cose_verified?: boolean
  root_verified?: boolean
  certificate_chain_verified?: boolean
  application: string
  enclave_type: string
  iam_role_arn?: string
  digest?: string
  version?: string
  capabilities?: string[]
  nitro_tpm_attest_available?: boolean
}

export interface AttestationDocument {
  timestamp: string
  nonce: string
  pcr_values: Record<string, string>
  enclave_info: EnclaveInfo
  user_data?: string
  public_key?: string
  public_key_attestation?: string
  /** Base64 CBOR of the signed COSE_Sign1 document — what the browser verifies itself. */
  raw_attestation?: string
}

export interface TrustStoreEntry {
  environment: string
  pcr_values: Record<string, string>
  last_updated: string
  updated_by?: string
}

// PCR descriptions
export const PCR_DESCRIPTIONS: Record<string, string> = {
  pcr0: 'BIOS/UEFI firmware',
  pcr1: 'Platform configuration',
  pcr2: 'Option ROM code',
  pcr3: 'Option ROM configuration',
  pcr4: 'Boot loader code (GRUB/etc)',
  pcr5: 'Boot loader configuration',
  pcr6: 'Resume from S4/S5',
  pcr7: 'Secure Boot policy',
  pcr8: 'Kernel command line (NitroTPM)',
  pcr9: 'Kernel image (NitroTPM)',
  pcr10: 'Reserved',
  pcr11: 'Reserved',
  pcr12: 'Reserved',
  pcr13: 'Reserved',
  pcr14: 'Reserved',
  pcr15: 'Reserved',
  pcr16: 'Application-specific (Boltz model hash)',
  pcr17: 'Reserved',
  pcr18: 'Reserved',
  pcr19: 'Reserved',
  pcr20: 'Reserved',
  pcr21: 'Reserved',
  pcr22: 'Reserved',
  pcr23: 'Reserved',
}

// Longer, human-readable explanation of what each PCR attests to. Shown on the
// Backend Connection tab so a reviewer understands what is being measured, and why
// PCR16 (the Boltz model hash) is the one that changes when the model is reloaded.
export const PCR_MEANINGS: Record<string, string> = {
  pcr0: 'Core system firmware (UEFI/BIOS) executable code. Changes when the platform firmware changes.',
  pcr1: 'Host platform configuration — firmware settings and data.',
  pcr2: 'UEFI drivers / Option ROM executable code from add-in hardware.',
  pcr3: 'UEFI drivers / Option ROM configuration and data.',
  pcr4: 'Boot loader (GRUB / shim) code and the boot attempt. Changes with the AMI image.',
  pcr5: 'Boot loader configuration and the GPT partition table.',
  pcr6: 'Platform-specific / resume-from-sleep events.',
  pcr7: 'Secure Boot policy — the PK/KEK/db/dbx key databases in effect at boot.',
  pcr8: 'Kernel command line measured by the boot loader.',
  pcr9: 'Kernel image and initrd loaded by the boot loader.',
  pcr16: 'Application measurement. The Boltz backend extends this with the SHA-384 hash of the loaded model weights, so it is the fingerprint of the exact model running. It changes on every model reload.',
}

// PCRs that carry no measurement on this platform and read as an all-zero digest.
// Binding a KMS policy to one of these asserts "nothing extra was extended here"
// (defense in depth), so we still allow selecting them even though they are zero.
export const ALWAYS_SELECTABLE_ZERO_PCRS = ['pcr12']

// The backend returns pcr_values keyed by bare numbers ("0", "4", "16"), but the
// whole UI keys on "pcr0"/"pcr16". Normalize at every ingestion point (attestation
// fetch, trust-store load) so descriptions, model-hash detection, comparison, and
// KMS selection all line up. Accepts either form and is idempotent.
export function normalizePcrKey(key: string): string {
  const k = key.toLowerCase().trim()
  if (k.startsWith('pcr')) return k
  if (/^\d+$/.test(k)) return `pcr${k}`
  return k
}

export function normalizePcrValues(raw: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw || {})) {
    out[normalizePcrKey(k)] = v
  }
  return out
}

// True for an unmeasured PCR (empty or an all-zero SHA-256/384 digest).
export function isZeroPcr(value: string | undefined | null): boolean {
  return !value || /^0+$/.test(value)
}

// Job types
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface PredictionJob {
  id: string
  job_id?: string  // Alternative ID field
  sequence_name?: string
  sequence_length: number
  status: JobStatus
  progress: number
  progress_stage?: string
  progress_message?: string
  confidence_score?: number
  created_at: string
  completed_at?: string
  error_message?: string
  pdb_url?: string
  structure?: {
    // Backend (JobResult.structure) returns the PDB text as `pdb_string`; `pdb_data`
    // kept for backward-compat. Read either.
    pdb_string?: string
    pdb_data?: string
    confidence_score?: number
    per_residue_confidence?: number[]
    confidence_scores?: number[]
    sequence_coverage?: number
  }
}

// Sequence library types
export interface SequenceLibraryItem {
  id: string
  name: string
  sequence: string
  type: 'protein' | 'rna' | 'dna'
  length: number
  encrypted: boolean
  s3_key?: string
  kms_key_id?: string
  created_at: string
  updated_at?: string
}

export interface SequenceInput {
  name: string
  sequence: string
  type: 'protein' | 'rna' | 'dna'
}

// Sequence types
export interface StoredSequence {
  id: string
  name: string
  sequence: string
  length: number
  encrypted: boolean
  s3_key?: string
  kms_key_id?: string
  created_at: string
}

// Sample sequences for testing
export const SAMPLE_SEQUENCES: Record<string, { name: string; sequence: string; description: string; type: 'protein' | 'rna' | 'dna' }> = {
  hemoglobin: {
    name: 'Hemoglobin Alpha',
    sequence: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH',
    description: 'Human hemoglobin alpha subunit (partial)',
    type: 'protein',
  },
  insulin: {
    name: 'Insulin',
    sequence: 'MALWMRLLPLLALLALWGPDPAAAFVNQHLCGSHLVEALYLVCGERGFFYTPKT',
    description: 'Human preproinsulin (partial)',
    type: 'protein',
  },
  lysozyme: {
    name: 'Lysozyme',
    sequence: 'MKALIVLGLVLLSVTVQGKVFERCELARTLKRLGMDGYRGISLANWMCLAKWESGYNTRATNYNAGDRSTDYGIFQINSRYWCNDGKTPGAVNACHLSCSALLQDNIADAVACAKRVVRDPQGIRAWVAWRNRCQNRDVRQYVQGCGV',
    description: 'Human lysozyme',
    type: 'protein',
  },
  gfp: {
    name: 'Green Fluorescent Protein',
    sequence: 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITLGMDELYK',
    description: 'Enhanced GFP',
    type: 'protein',
  },
  ubiquitin: {
    name: 'Ubiquitin',
    sequence: 'MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG',
    description: 'Human ubiquitin',
    type: 'protein',
  },
  mpro: {
    name: 'SARS-CoV-2 Mpro',
    sequence: 'SGFRKMAFPSGKVEGCMVQVTCGTTTLNGLWLDDVVYCPRHVICTSEDMLNPNYEDLLIRKSNHNFLVQAGNVQLRVIGHSMQNCVLKLKVDTANPKTPKYKFVRIQPGQTFSVLACYNGSPSGVYQCAMRPNFTIKGSFLNGSCGSVGFNIDYDCVSFCYMHHMELPTGVHAGTDLEGNFYGPFVDRQTAQAAGTDTTITVNVLAWLYAAVINGDRWFLNRFTTTLNDFNLVAMKYNYEPLTQDHVDILGPLSAQTGIAVLDMCASLKELLQNGMNGRTILGSALLEDEFTPFDVVRQCSGVTFQ',
    description: 'Main protease from SARS-CoV-2',
    type: 'protein',
  },
}

// KMS Policy types
export interface KMSKeyPolicy {
  Version: string
  Id: string
  Statement: KMSPolicyStatement[]
}

export interface KMSPolicyStatement {
  Sid: string
  Effect: 'Allow' | 'Deny'
  Principal: { AWS: string | string[] } | '*'
  Action: string | string[]
  Resource: string
  Condition?: {
    StringEquals?: Record<string, string>
    StringNotEquals?: Record<string, string>
    StringLike?: Record<string, string>
    Bool?: Record<string, string>
    Null?: Record<string, string>
  }
}

export interface PCRCondition {
  pcr: string
  value: string
  description?: string
}

// Model types (for Biophysicist role)
export type ModelStatus = 'uploading' | 'validating' | 'deploying' | 'active' | 'failed' | 'inactive'

export interface ModelVersion {
  id: string
  name: string
  version: string
  status: ModelStatus
  s3_key: string
  size_bytes: number
  checksum: string
  created_at: string
  deployed_at?: string
  error_message?: string
  is_active: boolean
}

// API response types
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// ============================================================================
// Browser-side attestation verification (services/attestationVerifier.ts)
// ============================================================================

/** Certificate summary surfaced by inspectAttestationDocument (for UI display). */
export interface CertificateInfo {
  subject?: string
  issuer?: string
  not_before?: string
  not_after?: string
  serial?: string
}

/**
 * The browser's own reading of an attestation document, from inspectAttestationDocument in
 * services/attestationVerifier. Derived entirely in the browser from the raw document bytes —
 * never from the attested host grading its own attestation.
 */
export interface AttestationInspection {
  /** chain anchored to the pinned AWS Nitro root, COSE signature valid, nonce matched. All three. */
  verified?: boolean
  module_id?: string
  nonce_verified?: boolean
  certificate_chain_present?: boolean
  chain_verified?: boolean
  signature_verified?: boolean
  certificates?: CertificateInfo[]
  attestation_document?: {
    module_id?: string
    timestamp?: number
    digest?: string
    /** PCR index (as a string) -> SHA-384 hex digest. */
    pcrs?: Record<string, string>
    certificate?: string
    cabundle_count?: number
    public_key?: string
    user_data?: string | null
    nonce?: string | null
  }
  /** Top-level copy, tolerated for compatibility. Prefer getVerifiedPcrs. */
  pcrs?: Record<string, string>
  error?: string
}

/** PCRs from an inspection result, whichever shape it arrived in (nested-first). */
export function getVerifiedPcrs(
  result: AttestationInspection | null | undefined,
): Record<string, string> | undefined {
  return result?.attestation_document?.pcrs ?? result?.pcrs
}

/** module_id from an inspection result, nested-first. */
export function getVerifiedModuleId(
  result: AttestationInspection | null | undefined,
): string | undefined {
  return result?.attestation_document?.module_id ?? result?.module_id
}