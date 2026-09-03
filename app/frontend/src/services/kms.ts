import { KMSClient, GetKeyPolicyCommand, PutKeyPolicyCommand, EncryptCommand, DescribeKeyCommand } from '@aws-sdk/client-kms'
import { fetchAuthSession } from 'aws-amplify/auth'
import type { KMSKeyPolicy, KMSPolicyStatement, PCRCondition } from '../types'

const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1'

// KMS key-policy condition key for a PCR. NitroTPM uses the `NitroTPMPCR<n>` form
// (e.g. kms:RecipientAttestation:NitroTPMPCR12) — distinct from Nitro Enclaves'
// `PCR<n>` form. `pcr` is the UI's normalized id like "pcr12".
function recipientAttestationKey(pcr: string): string {
  const n = pcr.replace(/^pcr/i, '').toUpperCase()
  return `kms:RecipientAttestation:NitroTPMPCR${n}`
}

// Get authenticated KMS client
async function getKMSClient(): Promise<KMSClient> {
  const session = await fetchAuthSession()
  
  if (!session.credentials) {
    throw new Error('No credentials available. Please sign in.')
  }

  return new KMSClient({
    region: REGION,
    credentials: session.credentials,
  })
}

// Resolve alias to key ID (needed for GetKeyPolicy which doesn't support aliases)
async function resolveKeyId(keyId: string): Promise<string> {
  // If it's already a key ID (UUID format), return as-is
  if (/^[a-f0-9-]{36}$/.test(keyId)) {
    return keyId
  }
  
  // If it's an alias, resolve to key ID using DescribeKey
  const client = await getKMSClient()
  const command = new DescribeKeyCommand({ KeyId: keyId })
  const response = await client.send(command)
  
  if (!response.KeyMetadata?.KeyId) {
    throw new Error(`Could not resolve key ID for: ${keyId}`)
  }
  
  return response.KeyMetadata.KeyId
}

// Get KMS key policy
export async function getKeyPolicy(keyId: string): Promise<KMSKeyPolicy> {
  const client = await getKMSClient()
  
  // GetKeyPolicy doesn't support aliases - must use actual key ID
  const resolvedKeyId = await resolveKeyId(keyId)
  
  const command = new GetKeyPolicyCommand({
    KeyId: resolvedKeyId,
    PolicyName: 'default',
  })

  const response = await client.send(command)
  
  if (!response.Policy) {
    throw new Error('No policy found for key')
  }

  return JSON.parse(response.Policy) as KMSKeyPolicy
}

// Get key metadata
export async function getKeyMetadata(keyId: string) {
  const client = await getKMSClient()
  
  const command = new DescribeKeyCommand({
    KeyId: keyId,
  })

  const response = await client.send(command)
  return response.KeyMetadata
}

// Update KMS key policy
export async function putKeyPolicy(keyId: string, policy: KMSKeyPolicy): Promise<void> {
  const client = await getKMSClient()
  
  // PutKeyPolicy doesn't support aliases - must use actual key ID
  const resolvedKeyId = await resolveKeyId(keyId)
  
  const command = new PutKeyPolicyCommand({
    KeyId: resolvedKeyId,
    PolicyName: 'default',
    Policy: JSON.stringify(policy),
  })

  await client.send(command)
}

// Create the explicit DENY statements that enforce attestation-gated decrypt.
//
// We deliberately do NOT add an Allow: the base permission to decrypt already comes from
// (a) the key policy's default `root`/`kms:*` delegation to IAM plus (b) the EC2 role's
// own IAM kms:Decrypt grant. The attestation control is therefore expressed entirely as
// explicit Denies, which override every Allow in IAM/KMS policy evaluation.
//
// We emit ONE Deny statement per PCR: `StringNotEquals` on the RecipientAttestation key,
// with NO Null guard. StringNotEquals is a NEGATED operator, so IAM treats a MISSING key
// as a match — the Deny therefore fires when the PCR is ABSENT (an unattested call that
// sent no Recipient at all) AND when it is PRESENT-BUT-WRONG, and is false only when the
// PCR is present and equals the trusted value. So decrypt is allowed only inside an
// instance presenting every expected PCR.
//
// A previous version added `Null: { key: 'false' }` to avoid denying non-attested/admin
// decrypts. That was the bug: it scoped each Deny to "present-only", so a plain
// kms:Decrypt (no attestation) was never denied and fell through to the IAM Allow — the
// weights/sequences could be unsealed with no attestation. We do NOT want that carve-out:
// this key is sealed, so EVERY unattested decrypt (including by an admin or root) must be
// denied. An admin who can edit the key policy does not also need to decrypt, and the
// Deny is scoped to Action kms:Decrypt only, so key administration (PutKeyPolicy,
// DescribeKey) and the encrypt side (GenerateDataKey) are unaffected.
export function createAttestationDenyStatements(
  sidPrefix: string,
  pcrConditions: PCRCondition[]
): KMSPolicyStatement[] {
  return pcrConditions.map((condition) => {
    const key = recipientAttestationKey(condition.pcr)
    return {
      Sid: `${sidPrefix}${condition.pcr.replace(/^pcr/i, '').toUpperCase()}`,
      Effect: 'Deny' as const,
      // Principal "*": deny ANY caller — including root/admins — that does not present a
      // matching attestation for this PCR.
      Principal: '*',
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: {
        // Negated operator with no Null guard: matches (denies) when the PCR is absent
        // OR present-but-wrong; passes only when present and equal to the trusted value.
        StringNotEquals: { [key]: condition.value },
      },
    }
  })
}

// Find the attestation statement(s) in a policy for a given Allow SID. Enforcement is
// now Deny-only, so this returns the per-PCR Deny statements (Sid starts with the deny
// prefix). For backward compatibility it also matches a legacy Allow statement with the
// exact sid (older policies wrote an Allow). Returns the first matching statement so
// existing callers that expect a single statement keep working; use
// extractEnforcedPCRConditions for the full, deny-aware read.
export function findAttestationStatement(policy: KMSKeyPolicy, sid: string): KMSPolicyStatement | undefined {
  const prefix = denySidPrefix(sid)
  return policy.Statement.find(
    (s) => s.Sid === sid || (typeof s.Sid === 'string' && s.Sid.startsWith(prefix))
  )
}

// Parse a RecipientAttestation condition key into a normalized pcr id ("pcr12"), or
// null if it is not one. Accepts both the NitroTPM key
// (kms:RecipientAttestation:NitroTPMPCR<n>) and the legacy Nitro Enclaves key
// (kms:RecipientAttestation:PCR<n>) so older policies still parse.
function parseRecipientAttestationKey(key: string): string | null {
  if (key.startsWith('kms:RecipientAttestation:NitroTPMPCR')) {
    return `pcr${key.replace('kms:RecipientAttestation:NitroTPMPCR', '').toLowerCase()}`
  }
  if (key.startsWith('kms:RecipientAttestation:PCR')) {
    return `pcr${key.replace('kms:RecipientAttestation:PCR', '').toLowerCase()}`
  }
  return null
}

// Extract PCR conditions from a SINGLE statement. Reads both the legacy Allow form
// (StringEquals: the value that IS required) and the Deny form (StringNotEquals: the
// value that must match, i.e. deny when NOT equal). Both encode the same "required PCR
// value", so the returned conditions are identical in meaning.
export function extractPCRConditions(statement: KMSPolicyStatement): PCRCondition[] {
  const conditions: PCRCondition[] = []
  const buckets = [statement.Condition?.StringEquals, statement.Condition?.StringNotEquals]
  for (const bucket of buckets) {
    if (!bucket) continue
    for (const [key, value] of Object.entries(bucket)) {
      const pcr = parseRecipientAttestationKey(key)
      if (pcr !== null) conditions.push({ pcr, value: value as string })
    }
  }
  return conditions
}

// Extract the full set of enforced PCR conditions for an Allow SID from a policy,
// reading across ALL of its per-PCR Deny statements (plus a legacy Allow if present).
// De-duplicates by pcr. This is what the UI should use to render "what the KMS policy
// actually enforces".
export function extractEnforcedPCRConditions(policy: KMSKeyPolicy, sid: string): PCRCondition[] {
  const prefix = denySidPrefix(sid)
  const byPcr = new Map<string, string>()
  for (const s of policy.Statement) {
    const isLegacyAllow = s.Sid === sid && s.Effect === 'Allow'
    const isDeny = typeof s.Sid === 'string' && s.Sid.startsWith(prefix)
    if (!isLegacyAllow && !isDeny) continue
    for (const c of extractPCRConditions(s)) byPcr.set(c.pcr, c.value)
  }
  return Array.from(byPcr, ([pcr, value]) => ({ pcr, value }))
}

// The Deny SID prefix for a given Allow SID (one Deny statement per PCR is created
// with this prefix, e.g. "...DenyIfPCR16").
function denySidPrefix(sid: string): string {
  return `${sid}DenyUnlessNitroTPMPCR`
}

// Add or update the attestation enforcement in a policy. We write TWO things:
//   1. An ALLOW scoped to the attested instance role ARN (`principalArn`), granting
//      kms:Decrypt only when the RecipientAttestation PCRs equal the trusted values.
//      This is the sole decrypt grant — the EC2 role no longer carries a broad IAM
//      kms:Decrypt, so decryption requires BOTH the exact principal AND attestation.
//   2. The per-PCR DENY backstop (Principal "*", StringNotEquals) that denies any decrypt
//      whose PCRs are absent or wrong, for every principal. An explicit Deny overrides
//      every Allow, so a wrong/unattested call is refused even if some other Allow existed.
//
// `principalArn` comes from the SIGNED attestation (the instance role ARN carried in
// user_data), not a hand-typed value, so the principal cannot be widened by accident.
export function upsertAttestationStatement(
  policy: KMSKeyPolicy,
  sid: string,
  principalArn: string,
  pcrConditions: PCRCondition[]
): KMSKeyPolicy {
  // Drop any prior Allow/Deny written by an earlier version (same sid) before re-adding.
  const prefix = denySidPrefix(sid)
  const kept = policy.Statement.filter(
    (s) => s.Sid !== sid && !(typeof s.Sid === 'string' && s.Sid.startsWith(prefix))
  )

  const allow: KMSPolicyStatement = {
    Sid: sid,
    Effect: 'Allow' as const,
    Principal: { AWS: principalArn },
    Action: 'kms:Decrypt',
    Resource: '*',
    Condition: {
      StringEquals: Object.fromEntries(
        pcrConditions.map((c) => [recipientAttestationKey(c.pcr), c.value])
      ),
    },
  }
  const denies = createAttestationDenyStatements(prefix, pcrConditions)

  return { ...policy, Statement: [...kept, allow, ...denies] }
}

// Remove BOTH the Allow and its explicit Deny statements from the policy.
export function removeAttestationStatement(policy: KMSKeyPolicy, sid: string): KMSKeyPolicy {
  const prefix = denySidPrefix(sid)
  return {
    ...policy,
    Statement: policy.Statement.filter(
      (s) => s.Sid !== sid && !(typeof s.Sid === 'string' && s.Sid.startsWith(prefix))
    ),
  }
}

// Encrypt data with KMS
export async function encryptData(keyId: string, plaintext: string): Promise<string> {
  const client = await getKMSClient()
  
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)

  const command = new EncryptCommand({
    KeyId: keyId,
    Plaintext: data,
  })

  const response = await client.send(command)
  
  if (!response.CiphertextBlob) {
    throw new Error('Encryption failed')
  }

  // Convert to base64
  return btoa(String.fromCharCode(...response.CiphertextBlob))
}

// Encrypt with encryption context
export async function encryptWithContext(
  keyId: string,
  plaintext: string,
  encryptionContext: Record<string, string>
): Promise<{ ciphertext: string; context: Record<string, string> }> {
  const client = await getKMSClient()
  
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)

  const command = new EncryptCommand({
    KeyId: keyId,
    Plaintext: data,
    EncryptionContext: encryptionContext,
  })

  const response = await client.send(command)
  
  if (!response.CiphertextBlob) {
    throw new Error('Encryption failed')
  }

  return {
    ciphertext: btoa(String.fromCharCode(...response.CiphertextBlob)),
    context: encryptionContext,
  }
}

// Default SID for attestation statements
export const BIOLOGIST_ATTESTATION_SID = 'AllowDecryptWithBiologistAttestation'
export const BIOPHYSICIST_ATTESTATION_SID = 'AllowDecryptWithBiophysicistAttestation'