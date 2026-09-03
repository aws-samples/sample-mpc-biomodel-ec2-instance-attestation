/**
 * Verification against a real attestation document from the deployed instance.
 *
 * Every other test in this directory builds its own fixtures, which means they can only prove the
 * verifier is self-consistent. This one proves the part no synthetic fixture can: that the
 * certificate pinned in `awsNitroRootCa.ts` is the anchor NitroTPM v2.0 documents actually chain
 * to, and that a genuine COSE_Sign1 signature verifies under the hand-rolled `Sig_structure`
 * encoding. If AWS were to re-root the NitroTPM PKI, this is the test that would notice.
 *
 * The clock is pinned to the document's own timestamp. That is not a convenience — the TPM leaf
 * certificate is valid for three hours, so the alternative is a test that expires the same
 * afternoon it was written. See the fixture's header.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  inspectAttestationDocument,
  parseAttestationDocument,
  verifyAttestationDocument,
  verifyCertificateChain,
  verifyCoseSignature,
} from '../attestationVerifier';
import { awsNitroRootCa } from '../awsNitroRootCa';
import {
  CAPTURED_AT_MS,
  LIVE_ATTESTATION_DOCUMENT_BASE64,
  LIVE_CHAIN_PATH,
  LIVE_NONCE,
} from './fixtures/liveAttestationDocument';

describe('a real NitroTPM attestation document', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CAPTURED_AT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('the chain reaches the pinned AWS Nitro root, one real signature at a time', async () => {
    const { attestationDoc } = parseAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64);
    const result = await verifyCertificateChain(
      attestationDoc.certificate!,
      attestationDoc.cabundle!,
      awsNitroRootCa(),
    );

    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    // Leaf, instance, zonal, regional, root — the shape the PITFALLS note describes, confirmed
    // against a live document rather than assumed from documentation.
    expect(result.path).toEqual(LIVE_CHAIN_PATH);
    expect(result.path[result.path.length - 1]).toBe('CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US');
  });

  test('the document signature verifies against the TPM leaf certificate', async () => {
    const cose = parseAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64);

    expect(await verifyCoseSignature(cose, cose.attestationDoc.certificate!)).toBe(true);
  });

  test('a single altered payload byte breaks the real signature', async () => {
    // The signature is checked over `Sig_structure`, assembled by hand. If that assembly were
    // wrong in a way that happened to verify, this would still pass — so change the document and
    // require it to fail. The byte chosen is inside `module_id`.
    const cose = parseAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64);
    cose.payload[20] ^= 0x01;

    expect(await verifyCoseSignature(cose, cose.attestationDoc.certificate!)).toBe(false);
  });

  test('inspection reports every check as passed, with the PCRs it read out itself', async () => {
    const result = await inspectAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64, LIVE_NONCE);

    expect(result.error).toBeUndefined();
    expect(result.chain_verified).toBe(true);
    expect(result.signature_verified).toBe(true);
    expect(result.nonce_verified).toBe(true);
    expect(result.verified).toBe(true);

    expect(result.attestation_document?.module_id).toBe('i-000fa553dad58a9f1-tpm0000000000000000');
    expect(result.certificates).toHaveLength(5);

    // All 24 registers are present, keyed by integer in the CBOR and rendered as decimal strings.
    // PCR4 is the one bound into the model key policy, so an empty or short PCR table here would
    // mean the operator pins a baseline that measures nothing.
    const pcrs = result.attestation_document?.pcrs ?? {};
    expect(Object.keys(pcrs)).toHaveLength(24);
    expect(pcrs['4']).toMatch(/^[0-9a-f]{96}$/);
    expect(pcrs['4']).not.toBe('0'.repeat(96));
  });

  test('the sealing path imports the bound HPKE key', async () => {
    // verifyAttestationDocument is what encryption.ts calls before sealing a payload, so this is
    // the step that decides whether a prompt can be encrypted at all. The key is a 91-byte EC
    // P-256 SPKI; it is imported for ECDH because @hpke/core performs the derivation.
    const result = await verifyAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64, LIVE_NONCE);

    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.publicKey).not.toBeNull();
    expect(result.publicKey?.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    expect(result.certExpiry).toBeInstanceOf(Date);
  });

  test('the same document is refused against a different nonce', async () => {
    const result = await inspectAttestationDocument(
      LIVE_ATTESTATION_DOCUMENT_BASE64,
      'f'.repeat(64),
    );

    expect(result.nonce_verified).toBe(false);
    expect(result.verified).toBe(false);
    // The cryptography is untouched by a nonce mismatch — this is a replay, not a forgery, and
    // the UI should be able to say which.
    expect(result.chain_verified).toBe(true);
    expect(result.signature_verified).toBe(true);
  });

  test('the certificates expire, and the verifier says so once they have', async () => {
    // Three hours and a minute after capture, the TPM leaf is out of date. Nothing about the
    // document has changed, so this is the check that keeps a captured document from being
    // replayed indefinitely by anyone who recorded one.
    vi.setSystemTime(CAPTURED_AT_MS + 3 * 60 * 60 * 1000 + 60_000);

    const result = await inspectAttestationDocument(LIVE_ATTESTATION_DOCUMENT_BASE64, LIVE_NONCE);

    expect(result.verified).toBe(false);
    expect(result.chain_verified).toBe(false);
    expect(result.error).toMatch(/valid|expire/i);
  });
});
