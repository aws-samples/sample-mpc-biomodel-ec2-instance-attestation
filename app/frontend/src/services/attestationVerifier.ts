/**
 * Attestation Document Verifier
 *
 * Client-side verification of AWS NitroTPM attestation documents. Nothing else in the app
 * checks them: the browser is the only party with an interest in the answer, so it does the
 * work itself rather than asking the instance under attestation whether it is trustworthy.
 *
 * The verification process:
 * 1. Parse the CBOR COSE_Sign1 structure
 * 2. Extract the certificate chain from the document
 * 3. Verify the chain link by link and anchor it to the pinned AWS Nitro root CA
 * 4. Verify the COSE_Sign1 signature with the leaf certificate's key
 * 5. Verify the nonce matches (freshness)
 * 6. Extract the public key from the verified document
 *
 * Every step fails closed. Steps 3 and 4 used to be stubs — the chain check compared
 * notBefore/notAfter and returned `verified: true` regardless of who signed what, and no code
 * anywhere checked the COSE signature. That left the pinned-PCR comparison carrying the whole
 * trust decision, which it cannot do: PCR values are just numbers in a document, and an
 * unsigned document is a document anyone can write. Both are now real.
 *
 * Two things are deliberately hand-rolled here, and both are load-bearing:
 *
 * - **DER parsing.** Signature verification needs the exact encoded bytes of `tbsCertificate`
 *   and of each `subjectPublicKeyInfo`, so `parseAsn1` records absolute offsets and hands back
 *   views rather than reconstructing anything. A re-encoding parser would verify signatures
 *   over bytes the CA never signed.
 * - **CBOR for the `Sig_structure`.** It is assembled byte by byte instead of through cbor-x.
 *   cbor-x re-encodes a Node `Buffer` as an indefinite-length CBOR *array*, and encodes a
 *   cross-realm `Uint8Array` (which is what jsdom's TextEncoder returns) the same way — either
 *   would produce a structure that fails to verify for reasons that look exactly like a
 *   signature forgery. See `attestationInspection.test.ts`.
 *
 * The trust anchor is pinned in `awsNitroRootCa.ts`; read the provenance block there before
 * changing anything about it.
 */

import * as cbor from 'cbor-x';

import { awsNitroRootCa } from './awsNitroRootCa';

// Aliased: this module has its own richer, internal CertificateInfo below.
import type {
  AttestationInspection,
  CertificateInfo as UiCertificateInfo,
} from '../types';

/** The decoded NitroTPM attestation document payload. */
export interface AttestationDocument {
  module_id?: string;
  timestamp?: number;
  digest?: string;
  /** PCR index -> digest bytes. NitroTPM uses `nitrotpm_pcrs`; Nitro Enclaves uses `pcrs`. */
  nitrotpm_pcrs?: Record<string, Uint8Array>;
  pcrs?: Record<string, Uint8Array>;
  /** DER-encoded leaf certificate. */
  certificate?: Uint8Array;
  /** DER-encoded intermediates, root last. */
  cabundle?: Uint8Array[];
  public_key?: Uint8Array | ArrayBuffer | { data: number[] };
  user_data?: Uint8Array;
  nonce?: Uint8Array | string;
}

/** COSE_Sign1 array: [protected, unprotected, payload, signature]. */
export interface ParsedCoseSign1 {
  protectedHeader: Uint8Array;
  unprotectedHeader: unknown;
  payload: Uint8Array;
  signature: Uint8Array;
  attestationDoc: AttestationDocument;
}

/** One node of the hand-rolled DER parse tree. */
interface Asn1Node {
  tag: number;
  /** Total encoded size of this node, header included — used to walk siblings. */
  length: number;
  /** Offset of the value bytes within the buffer the parse started from. */
  start: number;
  /** The value bytes, a view into the source buffer. */
  value: Uint8Array;
  /** The complete element including its header — the bytes a signature is computed over. */
  encoded: Uint8Array;
  children: Asn1Node[];
}

interface CertificateInfo {
  raw: Uint8Array;
  notBefore: Date | null;
  notAfter: Date | null;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  /** DER SubjectPublicKeyInfo — what verifies the certificates this one issued. */
  spkiBytes?: Uint8Array;
  /** Exact DER of tbsCertificate: the bytes the issuer signed. */
  tbsBytes?: Uint8Array;
  /** OID from the outer signatureAlgorithm. */
  signatureOid?: string | null;
  /** signatureValue BIT STRING contents with the unused-bits byte stripped. */
  signatureBytes?: Uint8Array;
  /** basicConstraints cA, or null when the extension is absent. */
  isCa?: boolean | null;
}

interface ChainVerification {
  verified: boolean;
  /** Subject DNs from the leaf up to the pinned anchor, in path order. */
  path: string[];
  leafCertExpiry: Date | null;
  error: string | null;
}

/**
 * Attestation verification result
 */
export class VerificationResult {
  verified: boolean;
  /** CryptoKey for encryption */
  publicKey: CryptoKey | null;
  /** Certificate expiry Date */
  certExpiry: Date | null;
  error: string | null;
  timestamp: number;

  constructor(
    verified: boolean,
    publicKey: CryptoKey | null,
    certExpiry: Date | null,
    error: string | null = null,
  ) {
    this.verified = verified;
    this.publicKey = publicKey;
    this.certExpiry = certExpiry;
    this.error = error;
    this.timestamp = Date.now();
  }
}

/**
 * Parse the CBOR COSE_Sign1 attestation document. Exported for tests, which need the parsed
 * pieces to exercise `verifyCoseSignature` directly.
 */
export function parseAttestationDocument(rawDocBase64: string): ParsedCoseSign1 {
  const rawBytes = base64ToUint8Array(rawDocBase64);

  // Decode COSE_Sign1 structure: [protected, unprotected, payload, signature]
  const coseSign1 = cbor.decode(rawBytes);

  if (!Array.isArray(coseSign1) || coseSign1.length < 4) {
    throw new Error('Invalid COSE_Sign1 structure');
  }

  const [protectedHeader, unprotectedHeader, payload, signature] = coseSign1;

  // Decode the attestation document from payload
  const attestationDoc = cbor.decode(payload) as AttestationDocument;

  return {
    protectedHeader,
    unprotectedHeader,
    payload,
    signature,
    attestationDoc,
  };
}

/**
 * Extract certificates from attestation document
 */
function extractCertificates(attestationDoc: AttestationDocument): {
  leafCert: Uint8Array;
  caBundle: Uint8Array[];
} {
  const leafCertDer = attestationDoc.certificate;
  const caBundleDer = attestationDoc.cabundle || [];

  if (!leafCertDer) {
    throw new Error('No certificate in attestation document');
  }

  return {
    leafCert: leafCertDer,
    caBundle: caBundleDer,
  };
}

/**
 * Parse an X.509 certificate from DER bytes.
 *
 * Tolerant by design: a certificate that will not parse yields a mostly-empty record rather
 * than an exception, so the UI can still list what it received. The trust path does not rely
 * on that tolerance — `verifyCertificateChain` requires `tbsBytes`, `signatureBytes`,
 * `signatureOid` and `spkiBytes` to be present and treats a missing one as a failure.
 *
 * Certificate     ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * tbsCertificate  ::= SEQUENCE { version, serialNumber, signature, issuer, validity,
 *                                subject, subjectPublicKeyInfo, ... extensions [3] }
 * validity        ::= SEQUENCE { notBefore, notAfter }
 */
async function parseCertificate(certDer: Uint8Array): Promise<CertificateInfo> {
  const certInfo: CertificateInfo = {
    raw: certDer,
    notBefore: null,
    notAfter: null,
    subject: null,
    issuer: null,
    serial: null,
    isCa: null,
  };

  try {
    const parsed = parseAsn1(certDer);
    if (parsed.tag === 0x30) {
      const tbsCert = parsed.children[0];
      if (tbsCert && tbsCert.tag === 0x30) {
        // The bytes the issuer signed, exactly as they arrived. Re-encoding them would be
        // wrong even if it round-tripped, because only these bytes are what was signed.
        certInfo.tbsBytes = tbsCert.encoded;
        certInfo.signatureOid = parseAlgorithmOid(parsed.children[1]);
        certInfo.signatureBytes = parseBitString(parsed.children[2]);

        // These indices assume version is present as [0] EXPLICIT, which holds for every v3
        // certificate — the validity and SPKI lookups below have always assumed it too.
        certInfo.serial = parseAsn1Serial(tbsCert.children[1]);
        certInfo.issuer = parseAsn1Name(tbsCert.children[3]);

        const validity = tbsCert.children[4];
        if (validity && validity.tag === 0x30 && validity.children.length >= 2) {
          certInfo.notBefore = parseAsn1Time(validity.children[0]);
          certInfo.notAfter = parseAsn1Time(validity.children[1]);
        }

        certInfo.subject = parseAsn1Name(tbsCert.children[5]);

        const spki = tbsCert.children[6];
        if (spki && spki.tag === 0x30) {
          certInfo.spkiBytes = spki.encoded;
        }

        certInfo.isCa = parseBasicConstraintsCa(tbsCert);
      }
    }
  } catch (e) {
    console.warn('[AttestationVerifier] Could not parse certificate details:', e);
  }

  return certInfo;
}

/**
 * A certificate reduced to the fields the UI shows. Exported so tests can assert what the
 * parser reads out of a certificate — including the pinned anchor's own subject.
 */
export async function inspectCertificate(certDer: Uint8Array): Promise<UiCertificateInfo> {
  const info = await parseCertificate(certDer);
  return {
    subject: info.subject ?? undefined,
    issuer: info.issuer ?? undefined,
    serial: info.serial ?? undefined,
    not_before: info.notBefore ? info.notBefore.toISOString() : undefined,
    not_after: info.notAfter ? info.notAfter.toISOString() : undefined,
  };
}

/** Read the OID out of an AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY }. */
function parseAlgorithmOid(algId: Asn1Node | undefined): string | null {
  const oidNode = algId?.tag === 0x30 ? algId.children[0] : undefined;
  return oidNode?.tag === 0x06 ? decodeOid(oidNode.value) : null;
}

/** Contents of a BIT STRING, dropping the leading unused-bit count. */
function parseBitString(node: Asn1Node | undefined): Uint8Array | undefined {
  if (!node || node.tag !== 0x03 || node.value.length < 1) return undefined;
  return node.value.subarray(1);
}

/**
 * basicConstraints cA (OID 2.5.29.19), or null when the extension is absent.
 *
 * Extensions ::= [3] EXPLICIT SEQUENCE OF Extension
 * Extension  ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
 * BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }
 *
 * pathLenConstraint is not enforced. The Nitro chain is five certificates deep with fixed
 * roles, and the anchor check below is what bounds the path — a pathLen violation could not
 * let an unrelated key issue certificates.
 */
function parseBasicConstraintsCa(tbsCert: Asn1Node): boolean | null {
  const extensionsTag = tbsCert.children.find((c) => c.tag === 0xa3);
  const extensions = extensionsTag?.children[0];
  if (!extensions || extensions.tag !== 0x30) return null;

  for (const ext of extensions.children) {
    if (ext.tag !== 0x30 || ext.children.length < 2) continue;
    const oidNode = ext.children[0];
    if (oidNode.tag !== 0x06 || decodeOid(oidNode.value) !== '2.5.29.19') continue;

    const extnValue = ext.children.find((c) => c.tag === 0x04);
    if (!extnValue) return null;
    try {
      const constraints = parseAsn1(extnValue.value);
      if (constraints.tag !== 0x30) return null;
      const ca = constraints.children.find((c) => c.tag === 0x01);
      // Absent cA inside a present extension means DEFAULT FALSE.
      return ca ? ca.value.length > 0 && ca.value[0] !== 0x00 : false;
    } catch {
      return null;
    }
  }
  return null;
}

/** Attribute type OIDs worth naming; anything else renders in dotted form. */
const NAME_OIDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
};

/** Decode a DER OBJECT IDENTIFIER's value bytes to dotted-decimal form. */
function decodeOid(value: Uint8Array): string {
  if (value.length === 0) return '';
  const parts = [Math.floor(value[0] / 40), value[0] % 40];
  let acc = 0;
  for (let i = 1; i < value.length; i++) {
    acc = acc * 128 + (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

/** Decode a DirectoryString. Everything here is UTF-8 in practice except BMPString. */
function decodeDirectoryString(node: Asn1Node): string {
  if (node.tag === 0x1e) {
    // BMPString: UTF-16BE
    let out = '';
    for (let i = 0; i + 1 < node.value.length; i += 2) {
      out += String.fromCharCode((node.value[i] << 8) | node.value[i + 1]);
    }
    return out;
  }
  return new TextDecoder().decode(node.value);
}

/** Escape the characters RFC 4514 reserves, so a rendered DN stays unambiguous. */
function escapeRfc4514(value: string): string {
  let out = value.replace(/([,+"\\<>;])/g, '\\$1');
  if (out.startsWith('#') || out.startsWith(' ')) out = '\\' + out;
  if (out.endsWith(' ') && !out.endsWith('\\ ')) out = out.slice(0, -1) + '\\ ';
  return out;
}

/**
 * Render an X.509 Name as an RFC 4514 string.
 *
 * RDNs come out most-specific first, the reverse of their DER order, matching what OpenSSL
 * and Python's `cryptography.x509.Name.rfc4514_string()` produce. The certificate sort in
 * the UI links a certificate to its issuer by string-comparing subject to issuer, so both
 * only strictly need to be rendered the same way — but matching the conventional form keeps
 * the displayed DNs recognisable.
 *
 * Name ::= RDNSequence
 * RDNSequence ::= SEQUENCE OF RelativeDistinguishedName
 * RelativeDistinguishedName ::= SET OF AttributeTypeAndValue
 * AttributeTypeAndValue ::= SEQUENCE { type OBJECT IDENTIFIER, value ANY }
 */
function parseAsn1Name(nameNode: Asn1Node | undefined): string | null {
  if (!nameNode || nameNode.tag !== 0x30) return null;

  const rdns: string[] = [];
  for (const rdn of nameNode.children) {
    if (rdn.tag !== 0x31) continue;
    const attrs: string[] = [];
    for (const atv of rdn.children) {
      if (atv.tag !== 0x30 || atv.children.length < 2) continue;
      const [typeNode, valueNode] = atv.children;
      if (typeNode.tag !== 0x06) continue;
      const oid = decodeOid(typeNode.value);
      attrs.push(`${NAME_OIDS[oid] || oid}=${escapeRfc4514(decodeDirectoryString(valueNode))}`);
    }
    // Multi-valued RDNs join with '+', keeping DER order within the SET.
    if (attrs.length > 0) rdns.push(attrs.join('+'));
  }

  return rdns.length > 0 ? rdns.reverse().join(',') : null;
}

/** Render a serial number INTEGER in decimal, the form OpenSSL and the console show. */
function parseAsn1Serial(serialNode: Asn1Node | undefined): string | null {
  if (!serialNode || serialNode.tag !== 0x02 || serialNode.value.length === 0) return null;
  const hex = Array.from(serialNode.value)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  try {
    // Serials are unsigned in practice — DER prepends 0x00 when the high bit is set — so a
    // straight hex read is right. BigInt because they routinely exceed 2^53.
    return BigInt('0x' + hex).toString();
  } catch {
    return hex;
  }
}

/**
 * DER parser.
 *
 * Recurses over the *same* buffer at absolute offsets, so every node's `encoded` and `value`
 * are views onto the original bytes at any depth. That is the whole point: signature
 * verification is over exact DER, and the previous version descended into a copy of each
 * container and then patched offsets with
 * `child.start = start + childOffset + (child.start - childOffset)`, which is only correct one
 * level down. `spki.start` sits two levels down, so reading the SPKI by offset returned bytes
 * from the wrong place. Nothing consumed `spkiBytes` at the time, so it stayed latent until
 * chain verification needed it.
 *
 * Descends into anything constructed (`tag & 0x20`), not just SEQUENCE and SET, so the
 * `[0]` version and `[3]` extensions context tags inside a tbsCertificate are walked too.
 * Malformed input throws rather than producing a partial tree a caller might trust.
 */
function parseAsn1(bytes: Uint8Array, offset = 0): Asn1Node {
  if (offset + 2 > bytes.length) throw new Error('Truncated DER element');

  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let headerLen = 2;

  if (length > 127) {
    const numBytes = length & 0x7f;
    // 0x80 is indefinite length: legal in BER, forbidden in DER. Cap at 4 so the shift below
    // cannot overflow into nonsense.
    if (numBytes === 0 || numBytes > 4) {
      throw new Error(`Unsupported DER length encoding (0x${bytes[offset + 1].toString(16)})`);
    }
    if (offset + 2 + numBytes > bytes.length) throw new Error('Truncated DER length');
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = length * 256 + bytes[offset + 2 + i];
    }
    headerLen = 2 + numBytes;
  }

  const start = offset + headerLen;
  const end = start + length;
  if (end > bytes.length) throw new Error('DER element runs past the end of the buffer');

  const node: Asn1Node = {
    tag,
    length: headerLen + length,
    start,
    value: bytes.subarray(start, end),
    encoded: bytes.subarray(offset, end),
    children: [],
  };

  if ((tag & 0x20) !== 0) {
    let childOffset = start;
    while (childOffset < end) {
      const child = parseAsn1(bytes, childOffset);
      // A zero-length header is impossible, but a bug here would loop forever.
      if (child.length <= 0) throw new Error('Zero-length DER element');
      node.children.push(child);
      childOffset += child.length;
    }
    if (childOffset !== end) throw new Error('DER children overrun their container');
  }

  return node;
}

/**
 * Parse ASN.1 Time (UTCTime or GeneralizedTime)
 */
function parseAsn1Time(asn1Node: Asn1Node | undefined): Date | null {
  if (!asn1Node) return null;

  const value = new TextDecoder().decode(asn1Node.value);

  if (asn1Node.tag === 0x17) {
    // UTCTime (YYMMDDHHMMSSZ)
    const year = parseInt(value.substr(0, 2));
    const fullYear = year >= 50 ? 1900 + year : 2000 + year;
    // Use Date.UTC to create proper UTC timestamp
    return new Date(
      Date.UTC(
        fullYear,
        parseInt(value.substr(2, 2)) - 1,
        parseInt(value.substr(4, 2)),
        parseInt(value.substr(6, 2)),
        parseInt(value.substr(8, 2)),
        parseInt(value.substr(10, 2)),
      ),
    );
  } else if (asn1Node.tag === 0x18) {
    // GeneralizedTime (YYYYMMDDHHMMSSZ)
    // Use Date.UTC to create proper UTC timestamp
    return new Date(
      Date.UTC(
        parseInt(value.substr(0, 4)),
        parseInt(value.substr(4, 2)) - 1,
        parseInt(value.substr(6, 2)),
        parseInt(value.substr(8, 2)),
        parseInt(value.substr(10, 2)),
        parseInt(value.substr(12, 2)),
      ),
    );
  }

  return null;
}

/**
 * Certificate signature algorithms this verifier accepts.
 *
 * ECDSA only, on purpose. The Nitro PKI is ECDSA P-384/SHA-384 from the root down to the TPM
 * leaf, so an RSA or Ed25519 signature here would mean something changed that nobody has
 * tested against. Failing with a message naming the OID is more useful than quietly
 * exercising an untried path — and much more useful than the previous behaviour, which was to
 * check no signature at all.
 */
const CERT_SIGNATURE_ALGORITHMS: Record<string, { hash: string }> = {
  '1.2.840.10045.4.3.2': { hash: 'SHA-256' }, // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': { hash: 'SHA-384' }, // ecdsa-with-SHA384
  '1.2.840.10045.4.3.4': { hash: 'SHA-512' }, // ecdsa-with-SHA512
};

/** Named curves, with the field size each ECDSA signature component is padded to. */
const EC_CURVES: Record<string, { namedCurve: string; fieldSize: number }> = {
  '1.2.840.10045.3.1.7': { namedCurve: 'P-256', fieldSize: 32 },
  '1.3.132.0.34': { namedCurve: 'P-384', fieldSize: 48 },
  '1.3.132.0.35': { namedCurve: 'P-521', fieldSize: 66 },
};

/** id-ecPublicKey. */
const ID_EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';

/**
 * Read the curve out of a DER SubjectPublicKeyInfo.
 *
 * WebCrypto will not import an EC key without being told the curve, and it rejects the import
 * if the curve it is told disagrees with the key — so this has to come from the SPKI itself
 * rather than being assumed to be P-384.
 */
function ecCurveFromSpki(spkiDer: Uint8Array | undefined): { namedCurve: string; fieldSize: number } {
  if (!spkiDer) throw new Error('Certificate has no subjectPublicKeyInfo');
  const spki = parseAsn1(spkiDer);
  const algId = spki.children[0];
  if (spki.tag !== 0x30 || !algId || algId.tag !== 0x30 || algId.children.length < 2) {
    throw new Error('Malformed subjectPublicKeyInfo');
  }
  if (parseAlgorithmOid(algId) !== ID_EC_PUBLIC_KEY_OID) {
    throw new Error('Certificate public key is not an EC key');
  }
  const curveNode = algId.children[1];
  if (curveNode.tag !== 0x06) throw new Error('EC key has no named curve');
  const oid = decodeOid(curveNode.value);
  const curve = EC_CURVES[oid];
  if (!curve) throw new Error(`Unsupported EC curve ${oid}`);
  return curve;
}

/**
 * Convert an X.509 ECDSA signature to the form WebCrypto wants.
 *
 * X.509 wraps (r, s) in `SEQUENCE { INTEGER r, INTEGER s }`; WebCrypto expects the IEEE P1363
 * form, r‖s fixed-width and unsigned. DER INTEGERs are signed, so r may carry a leading 0x00
 * to keep it positive or be shorter than the field when its high bytes are zero — both have to
 * be normalised, and getting it wrong makes valid signatures fail.
 *
 * COSE signatures are already P1363 and skip this entirely.
 */
function derEcdsaToRaw(der: Uint8Array, fieldSize: number): Uint8Array<ArrayBuffer> {
  const seq = parseAsn1(der);
  if (seq.tag !== 0x30 || seq.children.length !== 2) {
    throw new Error('Malformed ECDSA signature');
  }
  const raw = new Uint8Array(fieldSize * 2);
  seq.children.forEach((component, i) => {
    if (component.tag !== 0x02) throw new Error('ECDSA signature component is not an INTEGER');
    let value = component.value;
    let lead = 0;
    while (lead < value.length - 1 && value[lead] === 0x00) lead++;
    value = value.subarray(lead);
    if (value.length > fieldSize) {
      throw new Error('ECDSA signature component is too large for the curve');
    }
    // Right-align within each half: leading zeros are significant in P1363.
    raw.set(value, fieldSize * (i + 1) - value.length);
  });
  return raw;
}

/**
 * A standalone copy of a buffer view.
 *
 * WebCrypto honours byteOffset on views, but the parse tree hands out subarrays of subarrays
 * and jsdom's realm boundary has already produced one class of silent misencoding in this
 * file's tests. Copying is a few hundred bytes and removes the question.
 */
function copyOf(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
}

/** True when `subject`'s signature verifies under `issuer`'s public key. */
async function verifySignedBy(subject: CertificateInfo, issuer: CertificateInfo): Promise<boolean> {
  if (!subject.tbsBytes || !subject.signatureBytes || !subject.signatureOid) {
    throw new Error('Certificate is missing the fields needed to verify its signature');
  }
  const algorithm = CERT_SIGNATURE_ALGORITHMS[subject.signatureOid];
  if (!algorithm) {
    throw new Error(`Unsupported certificate signature algorithm ${subject.signatureOid}`);
  }

  const curve = ecCurveFromSpki(issuer.spkiBytes);
  const key = await crypto.subtle.importKey(
    'spki',
    copyOf(issuer.spkiBytes as Uint8Array),
    { name: 'ECDSA', namedCurve: curve.namedCurve },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: algorithm.hash },
    key,
    derEcdsaToRaw(subject.signatureBytes, curve.fieldSize),
    copyOf(subject.tbsBytes),
  );
}

/** Describe a certificate for an error message, without assuming it parsed. */
function certLabel(info: CertificateInfo, fallback: string): string {
  return info.subject ?? fallback;
}

/**
 * Verify a certificate chain and anchor it to a pinned root.
 *
 * `anchorDer` has no default. Every call site names its anchor, so `grep awsNitroRootCa`
 * finds all of them — tests pass their own synthetic root, and the exported entry points
 * always pass the real one. There is no way to reach the public API with the check relaxed.
 *
 * The path is built by *linking* — each step looks for a certificate whose subject is the
 * current certificate's issuer and whose key actually verifies the current signature — not by
 * trusting the order the document supplied. Two consequences worth stating:
 *
 * - A self-signed certificate in the document can never terminate the path. Nitro documents
 *   include a copy of the root in the cabundle; it is treated as any other candidate, and the
 *   anchor step verifies against the *pinned* bytes. Substituting a same-DN forgery therefore
 *   fails at the signature, not at a name comparison.
 * - The loop terminates only by reaching the anchor. Running out of candidates is a failure,
 *   never a pass.
 */
export async function verifyCertificateChain(
  leafCert: Uint8Array,
  caBundle: Uint8Array[],
  anchorDer: Uint8Array,
): Promise<ChainVerification> {
  const path: string[] = [];
  let leafCertExpiry: Date | null = null;

  try {
    const now = new Date();
    const anchor = await parseCertificate(anchorDer);
    if (!anchor.subject) throw new Error('Pinned trust anchor could not be parsed');
    assertWithinValidity(anchor, now, 'Pinned trust anchor');
    if (anchor.isCa !== true) throw new Error('Pinned trust anchor is not marked as a CA');

    const candidates = await Promise.all(caBundle.map((der) => parseCertificate(der)));
    const used = new Set<number>();

    let current = await parseCertificate(leafCert);
    if (!current.subject || !current.issuer) {
      throw new Error('Leaf certificate could not be parsed');
    }
    leafCertExpiry = current.notAfter;
    assertWithinValidity(current, now, 'Leaf certificate');
    path.push(current.subject);

    // One iteration per supplied certificate, plus the anchor step. `used` already prevents
    // revisiting a certificate; this bounds the walk even if that reasoning is ever broken.
    for (let step = 0; step <= candidates.length; step++) {
      if (current.issuer === anchor.subject) {
        if (!(await verifySignedBy(current, anchor))) {
          throw new Error(
            `${certLabel(current, 'certificate')} claims to be issued by the AWS Nitro root ` +
              'but its signature does not verify under the pinned root key',
          );
        }
        path.push(anchor.subject);
        return { verified: true, path, leafCertExpiry, error: null };
      }

      const next = await findIssuer(current, candidates, used, now);
      if (!next) {
        throw new Error(
          `No path to the pinned AWS Nitro root CA: nothing in the document issued ` +
            `${certLabel(current, 'the certificate')} (issuer ${current.issuer})`,
        );
      }
      used.add(next.index);
      current = next.info;
      path.push(current.subject as string);
    }

    throw new Error('Certificate chain does not reach the pinned AWS Nitro root CA');
  } catch (error) {
    return { verified: false, path, leafCertExpiry, error: (error as Error).message };
  }
}

/**
 * Find an unused CA certificate that issued `subject`, verifying the signature to confirm it.
 *
 * A candidate whose subject matches but which is outside its validity window aborts the search
 * rather than being skipped: it is the certificate that was meant to be used, and reporting
 * "expired" is more truthful than continuing and reporting "no path".
 */
async function findIssuer(
  subject: CertificateInfo,
  candidates: CertificateInfo[],
  used: Set<number>,
  now: Date,
): Promise<{ index: number; info: CertificateInfo } | null> {
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    const candidate = candidates[i];
    if (!candidate.subject || candidate.subject !== subject.issuer) continue;
    // RFC 5280 requires basicConstraints cA on any certificate that issues certificates. The
    // whole Nitro chain sets it, so requiring it costs nothing and stops an end-entity
    // certificate from being pressed into service as a CA.
    if (candidate.isCa !== true) continue;
    assertWithinValidity(candidate, now, certLabel(candidate, `Certificate ${i}`));
    if (await verifySignedBy(subject, candidate)) return { index: i, info: candidate };
  }
  return null;
}

/** Throw unless `info` is inside its validity window; an absent window is itself a failure. */
function assertWithinValidity(info: CertificateInfo, now: Date, label: string): void {
  if (!info.notBefore || !info.notAfter) {
    throw new Error(`${label} has no readable validity period`);
  }
  if (now < info.notBefore) throw new Error(`${label} is not yet valid`);
  if (now > info.notAfter) throw new Error(`${label} has expired`);
}

/**
 * COSE algorithms this verifier accepts (RFC 8152 §8.1), each pinned to its curve.
 *
 * Pairing the algorithm with a curve closes an algorithm-confusion gap: without it, a document
 * could name ES256 while the leaf key is P-384 and the verifier would hash with SHA-256 over a
 * P-384 key. NitroTPM signs with ES384.
 */
const COSE_ALGORITHMS: Record<number, { hash: string; namedCurve: string }> = {
  [-7]: { hash: 'SHA-256', namedCurve: 'P-256' }, // ES256
  [-35]: { hash: 'SHA-384', namedCurve: 'P-384' }, // ES384
  [-36]: { hash: 'SHA-512', namedCurve: 'P-521' }, // ES512
};

/** CBOR byte string, definite length. See the note about cbor-x at the top of this file. */
function cborByteString(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  let header: number[];
  if (n < 24) header = [0x40 | n];
  else if (n < 0x100) header = [0x58, n];
  else if (n < 0x10000) header = [0x59, n >> 8, n & 0xff];
  else header = [0x5a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

  const out = new Uint8Array(header.length + n);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

/**
 * The bytes a COSE_Sign1 signature is actually computed over (RFC 8152 §4.4):
 *
 *   Sig_structure = [ "Signature1", protected, external_aad, payload ]
 *
 * Encoded by hand: `0x84` array(4), `0x6a` + "Signature1", the protected header as a byte
 * string, an empty byte string for external_aad, then the payload.
 */
function coseSigStructure(protectedHeader: Uint8Array, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const context = Uint8Array.from('Signature1', (c) => c.charCodeAt(0));
  const parts = [
    Uint8Array.of(0x84),
    Uint8Array.of(0x60 | context.length), // tstr(10)
    context,
    cborByteString(protectedHeader),
    Uint8Array.of(0x40), // bstr(0): external_aad is empty
    cborByteString(payload),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Read `alg` (label 1) from the protected header.
 *
 * cbor-x may hand back a Map or a plain object depending on its `mapsAsObjects` setting, so
 * both are handled; an integer key becomes the string "1" in the object form.
 */
function coseAlgorithm(protectedHeader: Uint8Array): number | null {
  if (!protectedHeader || protectedHeader.length === 0) return null;
  const decoded = cbor.decode(copyOf(protectedHeader));
  const alg = decoded instanceof Map ? decoded.get(1) : (decoded as Record<string, unknown>)?.['1'];
  return typeof alg === 'number' ? alg : null;
}

/**
 * Verify the COSE_Sign1 signature over the attestation document.
 *
 * This is the check that makes the rest of the document mean anything. Without it the PCR
 * values, the module id and the bound public key are all just fields somebody wrote, and the
 * certificate chain only proves that AWS issued *a* certificate — not that it vouched for
 * these bytes.
 *
 * `leafCertDer` must be the certificate the chain verification anchored, otherwise this proves
 * only that the document was signed by a key of unknown provenance.
 */
export async function verifyCoseSignature(
  cose: ParsedCoseSign1,
  leafCertDer: Uint8Array,
): Promise<boolean> {
  const leafCert = await parseCertificate(leafCertDer);
  const alg = coseAlgorithm(cose.protectedHeader);
  if (alg === null) throw new Error('COSE protected header carries no algorithm');
  const params = COSE_ALGORITHMS[alg];
  if (!params) throw new Error(`Unsupported COSE signature algorithm ${alg}`);

  const curve = ecCurveFromSpki(leafCert.spkiBytes);
  if (curve.namedCurve !== params.namedCurve) {
    throw new Error(
      `COSE algorithm ${alg} expects ${params.namedCurve} but the leaf certificate key is ` +
        curve.namedCurve,
    );
  }
  // COSE ECDSA signatures are already r‖s. A wrong length here would otherwise reach WebCrypto
  // and come back as a plain "false", which reads like a forgery rather than a malformed input.
  if (cose.signature.length !== curve.fieldSize * 2) {
    throw new Error(
      `COSE signature is ${cose.signature.length} bytes, expected ${curve.fieldSize * 2} for ` +
        curve.namedCurve,
    );
  }

  const key = await crypto.subtle.importKey(
    'spki',
    copyOf(leafCert.spkiBytes as Uint8Array),
    { name: 'ECDSA', namedCurve: curve.namedCurve },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: params.hash },
    key,
    copyOf(cose.signature),
    coseSigStructure(cose.protectedHeader, cose.payload),
  );
}

/**
 * Verify nonce matches what we sent
 */
function verifyNonce(attestationDoc: AttestationDocument, expectedNonce: string): boolean {
  const docNonce = attestationDoc.nonce;

  if (!docNonce) {
    console.warn('[AttestationVerifier] No nonce in attestation document');
    return false;
  }

  // Convert nonce to string for comparison
  let nonceStr: string;
  if (docNonce instanceof Uint8Array) {
    nonceStr = new TextDecoder().decode(docNonce);
  } else if (typeof docNonce === 'string') {
    nonceStr = docNonce;
  } else {
    nonceStr = String(docNonce);
  }

  return nonceStr === expectedNonce;
}

/**
 * Extract and import the public key from attestation document
 */
async function extractPublicKey(attestationDoc: AttestationDocument): Promise<CryptoKey> {
  const publicKeyBytes = attestationDoc.public_key;

  if (!publicKeyBytes) {
    throw new Error('No public key in attestation document');
  }

  // Copy into a fresh Uint8Array rather than reaching for `.buffer`. The bytes arrive as a view
  // into the decoder's own buffer, so `.buffer` is the whole decode buffer and not the key —
  // hence the copy. Hand WebCrypto the typed array and not the underlying ArrayBuffer: both are
  // valid BufferSource in a browser, but Node's WebCrypto rejects a bare ArrayBuffer that
  // originated in the jsdom realm, which made this the one step of verification that could not be
  // exercised in a test against a real document.
  let keyBytes: Uint8Array<ArrayBuffer>;
  if (publicKeyBytes instanceof Uint8Array) {
    keyBytes = new Uint8Array(publicKeyBytes.length);
    keyBytes.set(publicKeyBytes);
  } else if (publicKeyBytes instanceof ArrayBuffer) {
    keyBytes = new Uint8Array(publicKeyBytes.byteLength);
    keyBytes.set(new Uint8Array(publicKeyBytes));
  } else if (typeof publicKeyBytes === 'object' && 'data' in publicKeyBytes) {
    // CBOR decoders that hand back {type: 'Buffer', data: [...]} rather than a view.
    keyBytes = new Uint8Array(publicKeyBytes.data as ArrayLike<number>);
  } else {
    throw new Error('Invalid public key format');
  }

  console.log('[AttestationVerifier] Public key buffer length:', keyBytes.length);

  // The bound key is EC P-256, used as the HPKE recipient key. Older builds bound RSA 2048
  // instead, so import by algorithm rather than assuming: the frontend and the AMI deploy
  // independently (Amplify in minutes, an AMI rebuild in far longer), and dispatching here
  // means the browser works against whichever build happens to be serving, in either order.
  //
  // An EC SPKI is ~91 bytes and an RSA 2048 SPKI ~294, but length is a fragile signal — key
  // in on the algorithm OID in the SPKI's AlgorithmIdentifier instead.
  if (isEcPublicKeySpki(keyBytes)) {
    // No key usages: P-256 keys are imported for ECDH, and HPKE performs the derivation via
    // @hpke/core. WebCrypto rejects ['encrypt'] on an ECDH key.
    return await crypto.subtle.importKey(
      'spki',
      keyBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, // extractable - @hpke/core re-exports the raw point
      [],
    );
  }

  // Legacy: RSA-OAEP hybrid encryption.
  // Set extractable to true for AWS ESDK keyring
  return await crypto.subtle.importKey(
    'spki',
    keyBytes,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    true, // extractable - needed for AWS ESDK keyring
    ['encrypt'],
  );
}

/**
 * True when a DER SubjectPublicKeyInfo names id-ecPublicKey (1.2.840.10045.2.1).
 *
 * Scans for the OID's DER encoding rather than walking the structure — the surrounding SPKI
 * is fixed-shape here and the OID is unambiguous, so a full parser buys nothing.
 */
function isEcPublicKeySpki(spki: Uint8Array): boolean {
  // 06 07 2A 86 48 CE 3D 02 01 = OBJECT IDENTIFIER, 7 bytes, 1.2.840.10045.2.1
  const ID_EC_PUBLIC_KEY = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  outer: for (let i = 0; i + ID_EC_PUBLIC_KEY.length <= spki.length; i++) {
    for (let j = 0; j < ID_EC_PUBLIC_KEY.length; j++) {
      if (spki[i + j] !== ID_EC_PUBLIC_KEY[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Convert base64 to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Main verification function
 *
 * Verifies an attestation document and returns the verified public key
 *
 * @param rawDocBase64 - Base64 encoded raw attestation document
 * @param expectedNonce - The nonce we sent to verify freshness
 * @returns Verification result with public key if successful
 */
export async function verifyAttestationDocument(
  rawDocBase64: string,
  expectedNonce?: string,
): Promise<VerificationResult> {
  try {
    console.log('[AttestationVerifier] Starting verification...');

    // Step 1: Parse the COSE_Sign1 structure
    const cose = parseAttestationDocument(rawDocBase64);
    const { attestationDoc } = cose;
    console.log('[AttestationVerifier] Parsed attestation document');

    // Step 2: Extract certificates
    const { leafCert, caBundle } = extractCertificates(attestationDoc);
    console.log(`[AttestationVerifier] Extracted ${caBundle.length + 1} certificates`);

    // Step 3: Verify the certificate chain against the pinned AWS Nitro root
    const chainResult = await verifyCertificateChain(leafCert, caBundle, awsNitroRootCa());
    if (!chainResult.verified) {
      return new VerificationResult(
        false,
        null,
        null,
        `Certificate chain verification failed: ${chainResult.error}`,
      );
    }
    console.log(`[AttestationVerifier] Chain verified: ${chainResult.path.join(' <- ')}`);

    // Step 4: Verify the COSE_Sign1 signature with the anchored leaf's key. Order matters —
    // verifying the signature first would say only that the document is self-consistent.
    if (!(await verifyCoseSignature(cose, leafCert))) {
      return new VerificationResult(false, null, null, 'Attestation document signature is invalid');
    }
    console.log('[AttestationVerifier] Document signature verified');

    // Step 5: Verify nonce (freshness)
    if (expectedNonce) {
      const nonceValid = verifyNonce(attestationDoc, expectedNonce);
      if (!nonceValid) {
        return new VerificationResult(false, null, null, 'Nonce verification failed');
      }
      console.log('[AttestationVerifier] Nonce verified');
    }

    // Step 6: Extract and import public key from verified document
    const publicKey = await extractPublicKey(attestationDoc);
    console.log('[AttestationVerifier] Public key imported');

    return new VerificationResult(true, publicKey, chainResult.leafCertExpiry, null);
  } catch (error) {
    console.error('[AttestationVerifier] Verification failed:', error);
    return new VerificationResult(false, null, null, (error as Error).message);
  }
}

/**
 * Get PCR values from attestation document
 */
export function getPcrValues(rawDocBase64: string): Record<string, Uint8Array> {
  try {
    const { attestationDoc } = parseAttestationDocument(rawDocBase64);
    return attestationDoc.nitrotpm_pcrs || attestationDoc.pcrs || {};
  } catch (error) {
    console.error('[AttestationVerifier] Failed to get PCR values:', error);
    return {};
  }
}

/**
 * Get module ID from attestation document
 */
export function getModuleId(rawDocBase64: string): string {
  try {
    const { attestationDoc } = parseAttestationDocument(rawDocBase64);
    return attestationDoc.module_id || 'unknown';
  } catch (error) {
    console.error('[AttestationVerifier] Failed to get module ID:', error);
    return 'unknown';
  }
}

/** Hex-encode PCR digests, which cbor-x hands back as byte strings. */
function pcrsToHex(pcrs: Record<string, Uint8Array> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [index, digest] of Object.entries(pcrs || {})) {
    if (digest instanceof Uint8Array) {
      out[index] = Array.from(digest)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else if (typeof digest === 'string') {
      out[index] = digest;
    }
  }
  return out;
}

/** Decode a nonce field to text for display, tolerating either wire form. */
function nonceToString(nonce: Uint8Array | string | undefined): string | null {
  if (nonce === undefined || nonce === null) return null;
  return nonce instanceof Uint8Array ? new TextDecoder().decode(nonce) : String(nonce);
}

/**
 * Inspect an attestation document in the browser and report what it contains.
 *
 * This is the source of the PCR baseline the operator pins. It has to be: the values shown
 * on screen and written to the trust store must come from the document the browser holds,
 * parsed locally. Asking the attested instance to report its own PCRs — which is what the
 * removed `POST /attestation/verify` endpoint did — pins whatever a compromised instance
 * cares to claim, and the subsequent comparison then always passes.
 *
 * `verified` requires all three cryptographic checks: the chain links up to the pinned AWS
 * Nitro root, the COSE_Sign1 signature verifies under the anchored leaf's key, and the nonce
 * matched if one was supplied. `chain_verified` and `signature_verified` are reported
 * separately so a failure says which check failed, and `certificates` is populated either way
 * so the UI can show what it was handed even when the verdict is a refusal.
 *
 * @param rawDocBase64 - Base64 CBOR COSE_Sign1 attestation document
 * @param expectedNonce - Nonce sent with the request, for the freshness check
 */
export async function inspectAttestationDocument(
  rawDocBase64: string,
  expectedNonce?: string,
): Promise<AttestationInspection> {
  try {
    const cose = parseAttestationDocument(rawDocBase64);
    const { attestationDoc } = cose;
    const caBundle = attestationDoc.cabundle || [];

    // Leaf first, then intermediates, root last — the order the document supplies. Only the
    // display list depends on that order; verifyCertificateChain rebuilds the path itself.
    const chain = attestationDoc.certificate
      ? [attestationDoc.certificate, ...caBundle]
      : [...caBundle];

    const certificates: UiCertificateInfo[] = [];
    for (const certDer of chain) {
      certificates.push(await inspectCertificate(certDer));
    }

    let chainVerified = false;
    let signatureVerified = false;
    let failure: string | null = null;

    if (!attestationDoc.certificate) {
      failure = 'Attestation document carries no leaf certificate';
    } else {
      const chainResult = await verifyCertificateChain(
        attestationDoc.certificate,
        caBundle,
        awsNitroRootCa(),
      );
      chainVerified = chainResult.verified;
      if (!chainVerified) {
        failure = chainResult.error;
      } else {
        try {
          signatureVerified = await verifyCoseSignature(cose, attestationDoc.certificate);
          if (!signatureVerified) failure = 'Attestation document signature is invalid';
        } catch (e) {
          failure = (e as Error).message;
        }
      }
    }

    const nonceVerified = expectedNonce ? verifyNonce(attestationDoc, expectedNonce) : false;
    if (!failure && expectedNonce && !nonceVerified) failure = 'Nonce did not match';

    return {
      // Fails closed: an unanchored chain, a bad signature, or a nonce that did not match all
      // land on `verified: false`.
      verified: chainVerified && signatureVerified && (!expectedNonce || nonceVerified),
      chain_verified: chainVerified,
      signature_verified: signatureVerified,
      module_id: attestationDoc.module_id,
      nonce_verified: nonceVerified,
      certificate_chain_present: chain.length > 0,
      certificates,
      error: failure ?? undefined,
      attestation_document: {
        module_id: attestationDoc.module_id,
        timestamp: attestationDoc.timestamp,
        digest: attestationDoc.digest,
        pcrs: pcrsToHex(attestationDoc.nitrotpm_pcrs || attestationDoc.pcrs),
        cabundle_count: caBundle.length,
        user_data: nonceToString(attestationDoc.user_data),
        nonce: nonceToString(attestationDoc.nonce),
      },
    };
  } catch (error) {
    console.error('[AttestationVerifier] Inspection failed:', error);
    return {
      verified: false,
      chain_verified: false,
      signature_verified: false,
      nonce_verified: false,
      certificate_chain_present: false,
      certificates: [],
      error: (error as Error).message,
    };
  }
}

export default {
  verifyAttestationDocument,
  inspectAttestationDocument,
  getPcrValues,
  getModuleId,
};
