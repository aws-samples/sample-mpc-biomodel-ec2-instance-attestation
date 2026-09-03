/**
 * Certificate-chain and COSE_Sign1 signature verification (threat model T-003).
 *
 * These are the checks that make an attestation document evidence rather than a JSON object
 * somebody typed. Before this, `verifyCertificateChain` compared validity dates and returned
 * `verified: true` no matter who had signed what, and nothing anywhere checked the COSE
 * signature — so the pinned-PCR comparison was carrying the whole trust decision alone.
 *
 * The pairing that matters most is `IMPOSTOR_DOCUMENT` versus `TEST_DOCUMENT`: the impostor's
 * root has a DN byte-identical to the real AWS Nitro root, and its chain is internally
 * flawless. Anchored to its own root it verifies; anchored to the pinned AWS root it does not.
 * That is the difference between pinning a key and comparing a string, and only a test with a
 * name collision in it can tell the two apart.
 *
 * ─── How the fixtures were generated ─────────────────────────────────────────────────────────
 *
 * Deliberately by other tools — openssl for the PKI and signatures, Python's `cbor2` for the
 * CBOR — so a fixture cannot agree with the verifier merely because the same code produced it.
 * `Sig_structure` in particular is hand-encoded in `attestationVerifier.ts`, and cbor2 is the
 * independent encoder that confirms the hand-encoding is right.
 *
 *   # test chain: root -> intermediate -> leaf, all ECDSA P-384/SHA-384, CA:TRUE on the CAs
 *   openssl ecparam -genkey -name secp384r1 -noout -out root.key
 *   openssl req -x509 -new -key root.key -sha384 -days 36500 \
 *       -subj "/C=US/O=Test/OU=TEST/CN=test.root.invalid" \
 *       -addext "basicConstraints=critical,CA:TRUE" -out root.crt
 *   # ...intermediate signed by root, leaf signed by intermediate (CA:FALSE), then:
 *   openssl verify -CAfile root.crt -untrusted int.crt leaf.crt   # -> leaf.crt: OK
 *
 *   # the impostor chain is the same three steps with the real root's DN:
 *   #   /C=US/O=Amazon/OU=AWS/CN=aws.nitro-enclaves
 *
 *   # document: payload and Sig_structure via cbor2, signature via openssl, DER -> P1363 in python
 *   payload   = cbor2.dumps({'module_id': ..., 'nitrotpm_pcrs': {...}, 'certificate': leaf_der,
 *                            'cabundle': [root_der, int_der], 'nonce': b'testnonce123', ...})
 *   protected = cbor2.dumps({1: -35})                       # ES384
 *   sig_input = cbor2.dumps(['Signature1', protected, b'', payload])
 *   raw       = der_to_raw(openssl_dgst_sha384_sign(leaf.key, sig_input), 48)
 *   document  = base64(cbor2.dumps([protected, {}, payload, raw]))
 *
 * The `.invalid` TLD is reserved by RFC 2606, so the test DNs cannot collide with a real one.
 */

import { describe, it, expect } from 'vitest';

import {
  inspectAttestationDocument,
  inspectCertificate,
  parseAttestationDocument,
  verifyCertificateChain,
  verifyCoseSignature,
} from '../attestationVerifier';
import { awsNitroRootCa } from '../awsNitroRootCa';

/** Well-formed document over the test chain: leaf -> test.intermediate -> test.root. */
const TEST_DOCUMENT =
  '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';

/**
 * Same construction, but the root's DN is byte-identical to the real AWS Nitro root and the
 * subordinate DNs imitate the real regional/instance names. Everything about it is internally
 * valid — this is what a forged attestation would actually look like.
 */
const IMPOSTOR_DOCUMENT =
  'hEShATgioFkIxqlpbW9kdWxlX2lka2ktMHRlc3QtdHBtaXRpbWVzdGFtcBsAAAGf1eVEAGZkaWdlc3RmU0hBMzg0bW5pdHJv' +
  'dHBtX3BjcnOlYTBYMPnvnpD66qCB7Miem0LZrjzWbmFNvW4pHCbcq1fPhD8Np6poJRdEJqCsXfpWa3GGkWExWDCCos+iFClB' +
  'RqchrUiz596SASnDqkHV0CLUQ62oC4WTqfgZKkibzwfrgg60l2mNvBVhMlgwyjHsoJuz2sqF3NIkzNUt/hcuihlDN907HNsl' +
  'akWcLicDimlFrDneZsrRshQVPvr/YTRYMLqkfln1q34Cb/4Lhc+G5aNElNpvtaEOke63q4OXZKDSgKPOX9PfycEiW3Wqfkgg' +
  'ymE4WDB+gfksjZmSDlXnipJXVRuMQeL3G5zoAS3mwTTkv+GDs0//Pq4MG3Cb7Ih7iGnjswhrY2VydGlmaWNhdGVZAlcwggJT' +
  'MIIB2aADAgECAhRGc8rIBU6n7t+d9e29Zkbc+gDMKTAKBggqhkjOPQQDAzBTMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1h' +
  'em9uMQwwCgYDVQQLDANBV1MxJTAjBgNVBAMMHHVzLWVhc3QtMS5hd3Mubml0cm8tZW5jbGF2ZXMwIBcNMjYwODEzMTYwMTA0' +
  'WhgPMjEyNTAzMDcxNjAxMDRaMF8xCzAJBgNVBAYTAlVTMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsMA0FXUzExMC8GA1UE' +
  'AwwoaS0wdGVzdC10cG0udXMtZWFzdC0xLmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEGBSuBBAAiA2IABKefQF2x' +
  'kI+Hedswl609zxuahC5D0cBzxiZBSAkxNi2m1HqyBBPk5Epu/4bU0gxt4fXMVYGoHyZ3U2aPWjLEMh7LcP2b315uQVHgVM7L' +
  'n+R417N8iTaqn9WneRCu2KoLNqNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOWWqP9h9nAw' +
  '5vgr3bVIodGeEgmIMB8GA1UdIwQYMBaAFFXw0p0AYeDLgef1S2jmK0UdG62vMAoGCCqGSM49BAMDA2gAMGUCMQDWixy0x558' +
  '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';

/**
 * The test chain again, correctly signed with SHA-384 by a P-384 key, but with the protected
 * header claiming ES256. An algorithm-confusion attempt: the verifier must refuse rather than
 * hash with SHA-256 over a P-384 key.
 */
const ALG_CONFUSION_DOCUMENT =
  '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';

/** DER of `CN=test.root.invalid,OU=TEST,O=Test,C=US`. */
const TEST_ROOT_DER_BASE64 =
  'MIICIjCCAaigAwIBAgIUO2W3mSzXaqVkU9f69kRpz9ATAW8wCgYIKoZIzj0EAwMwRzELMAkGA1UEBhMCVVMxDTALBgNVBAoM' +
  'BFRlc3QxDTALBgNVBAsMBFRFU1QxGjAYBgNVBAMMEXRlc3Qucm9vdC5pbnZhbGlkMCAXDTI2MDgxMzE1Mjc0MFoYDzIxMjYw' +
  'NzIwMTUyNzQwWjBHMQswCQYDVQQGEwJVUzENMAsGA1UECgwEVGVzdDENMAsGA1UECwwEVEVTVDEaMBgGA1UEAwwRdGVzdC5y' +
  'b290LmludmFsaWQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQru/0cDJvRUitCeCk+qhzfN3zFKq2WxCWicUV0fM9iVYkyfLUi' +
  'lB+rDJtkWXVxVDDV1oU9y91HPiyEdxBtZQfo8plWEvC5mbn8kLpx2y9sKERzQvdNbnCpzVU8/pjwPfqjUzBRMB0GA1UdDgQW' +
  'BBT9nbQsTjP5NbSfo6JorLPF5P2Q7TAfBgNVHSMEGDAWgBT9nbQsTjP5NbSfo6JorLPF5P2Q7TAPBgNVHRMBAf8EBTADAQH/' +
  'MAoGCCqGSM49BAMDA2gAMGUCMQDX6fXCK0qpDuc0y09Qf3QnOEcaG+nbFSfiei/0utHmrwxD+cJ7CNUgz0JeILUwYt0CMA57' +
  'xHbwVgyyuk89Eea59PqfyCVdUXsbWErr9Og53p7h+sC8KLkD3zjvl2Bucln4ww==';

/** DER of the impostor root: the real AWS root's DN over an unrelated key. */
const IMPOSTOR_ROOT_DER_BASE64 =
  'MIICNjCCAbygAwIBAgIUc2D3fJWEkAemL1cVjKpDIYEwL6kwCgYIKoZIzj0EAwMwSTELMAkGA1UEBhMCVVMxDzANBgNVBAoM' +
  'BkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwIBcNMjYwODEzMTYwMTA0WhgPMjEy' +
  'NjA3MjAxNjAxMDRaMEkxCzAJBgNVBAYTAlVTMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsMA0FXUzEbMBkGA1UEAwwSYXdz' +
  'Lm5pdHJvLWVuY2xhdmVzMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEsqpWLfpic1mjF5luoCZZYp3zHoiCgzrSYMdHPXluKB8w' +
  '7WK5EB2BJnbjOu7GUxEfTnIVuHmw91Ml/iZ5vV4D8MGc3NAylxu9SBfAxQsSSF3bwFelpGoJbXIxEU/yiQjso2MwYTAdBgNV' +
  'HQ4EFgQUWiE/PE9zQM82Or3iJoZAUwyTw8wwHwYDVR0jBBgwFoAUWiE/PE9zQM82Or3iJoZAUwyTw8wwDwYDVR0TAQH/BAUw' +
  'AwEB/zAOBgNVHQ8BAf8EBAMCAYYwCgYIKoZIzj0EAwMDaAAwZQIwXHLKam2W1e+kCJzbTqc7atS31OAWCufHMcB82vyFROtr' +
  'WWHK7GvH2A5Ov8PKT18QAjEA6heqoC5FicVGZES8lZyBW1dsACheLX4SQNY2uELf1+SrTN2Z1AqHkzUSsp05F9/M';

const TEST_NONCE = 'testnonce123';

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The document's leaf and cabundle, as the verifier receives them. */
function chainOf(documentBase64: string) {
  const { attestationDoc } = parseAttestationDocument(documentBase64);
  return {
    leaf: attestationDoc.certificate as Uint8Array,
    caBundle: attestationDoc.cabundle as Uint8Array[],
  };
}

/**
 * Flip one bit inside the *payload*, leaving every CBOR length intact so the document still
 * parses. Anchored on an ASCII marker so the edit lands somewhere meaningful rather than in
 * padding — `atLast` picks the final occurrence, which for 'nonce' is the value, not the key.
 */
function tamperAfter(documentBase64: string, marker: string, skip: number): string {
  const bytes = fromBase64(documentBase64);
  const needle = Uint8Array.from(marker, (c) => c.charCodeAt(0));
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((b, j) => bytes[i + j] === b)) {
      bytes[i + needle.length + skip] ^= 0x01;
      return toBase64(bytes);
    }
  }
  throw new Error(`marker ${marker} not found in fixture`);
}

describe('pinned AWS Nitro root CA', () => {
  // If either assertion fails, the trust anchor has been changed. That is not necessarily
  // wrong, but it must be deliberate: re-run the curl/shasum/openssl commands in
  // awsNitroRootCa.ts and update the constant and this test together.
  it('is the certificate AWS publishes', async () => {
    const digest = await crypto.subtle.digest('SHA-256', awsNitroRootCa());
    expect(toHex(new Uint8Array(digest))).toBe(
      '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b',
    );
  });

  it('is the self-signed aws.nitro-enclaves root, valid into 2049', async () => {
    const info = await inspectCertificate(awsNitroRootCa());
    expect(info.subject).toBe('CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US');
    expect(info.issuer).toBe(info.subject);
    expect(info.not_after).toBe('2049-10-28T14:28:05.000Z');
  });
});

describe('verifyCertificateChain', () => {
  it('accepts a chain that links to its anchor and reports the path', async () => {
    // Also the regression test for the DER offset bug: the intermediate's public key is read
    // out of the certificate two levels down in the parse tree, and importing it at the wrong
    // offset makes this fail rather than silently passing.
    const { leaf, caBundle } = chainOf(TEST_DOCUMENT);
    const result = await verifyCertificateChain(leaf, caBundle, fromBase64(TEST_ROOT_DER_BASE64));

    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.path).toEqual([
      'CN=i-0test-tpm.us-east-1.aws,OU=TEST,O=Test,C=US',
      'CN=test.intermediate.invalid,OU=TEST,O=Test,C=US',
      'CN=test.root.invalid,OU=TEST,O=Test,C=US',
    ]);
  });

  it('rejects a chain that does not reach the anchor', async () => {
    const { leaf, caBundle } = chainOf(TEST_DOCUMENT);
    const result = await verifyCertificateChain(leaf, caBundle, awsNitroRootCa());

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/No path to the pinned AWS Nitro root CA/);
  });

  it('rejects an impostor root that copies the AWS root DN exactly', async () => {
    // The whole point of pinning. This chain is internally valid, its DNs are indistinguishable
    // from the real ones, and it still fails — because the pinned *key* does not verify the
    // intermediate. A name comparison would have accepted it.
    const { leaf, caBundle } = chainOf(IMPOSTOR_DOCUMENT);
    const result = await verifyCertificateChain(leaf, caBundle, awsNitroRootCa());

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/signature does not verify under the pinned root key/);
  });

  it('accepts that same impostor chain under its own root', async () => {
    // Paired with the test above: it proves the rejection came from the anchor swap and not
    // from a malformed fixture. Without this, the previous test would also pass if the
    // impostor document were simply broken.
    const { leaf, caBundle } = chainOf(IMPOSTOR_DOCUMENT);
    const result = await verifyCertificateChain(
      leaf,
      caBundle,
      fromBase64(IMPOSTOR_ROOT_DER_BASE64),
    );

    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.path[0]).toBe(
      'CN=i-0test-tpm.us-east-1.aws.nitro-enclaves,OU=AWS,O=Amazon,C=US',
    );
  });

  it('rejects a chain with the intermediate removed', async () => {
    const { leaf, caBundle } = chainOf(TEST_DOCUMENT);
    const rootOnly = caBundle.filter((_, i) => i === 0);
    const result = await verifyCertificateChain(leaf, rootOnly, fromBase64(TEST_ROOT_DER_BASE64));

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/No path to the pinned AWS Nitro root CA/);
  });

  it('rejects a leaf whose signature has been altered', async () => {
    const { leaf, caBundle } = chainOf(TEST_DOCUMENT);
    const tampered = new Uint8Array(leaf);
    tampered[tampered.length - 1] ^= 0x01;
    const result = await verifyCertificateChain(
      tampered,
      caBundle,
      fromBase64(TEST_ROOT_DER_BASE64),
    );

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/No path to the pinned AWS Nitro root CA/);
  });

  it('does not let a self-signed certificate stand in for the anchor', async () => {
    // The impostor root is self-signed under the AWS root's DN, so name-based reasoning would
    // make it its own trust anchor. Presented alone, with nothing else in the bundle, it is
    // still refused: the pinned key does not verify it.
    const impostorRoot = fromBase64(IMPOSTOR_ROOT_DER_BASE64);
    const result = await verifyCertificateChain(impostorRoot, [], awsNitroRootCa());

    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/signature does not verify under the pinned root key/);
  });

  it("verifies the real AWS root's own signature", async () => {
    // The only check here that runs against a certificate AWS actually issued, so it is the
    // only evidence that the DER offsets, SPKI extraction, P-384 import, DER->P1363 conversion
    // and SHA-384 digest all work on real Nitro PKI bytes rather than only on openssl output.
    // The chain is trivially [anchor] -> anchor, and passing is correct: the anchor is trusted
    // by definition. It is not a way in, either — a document whose leaf is the root would then
    // have to carry a COSE signature made with the root's private key.
    const root = awsNitroRootCa();
    const result = await verifyCertificateChain(root, [], root);

    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.path).toEqual([
      'CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US',
      'CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US',
    ]);
  });
});

describe('verifyCoseSignature', () => {
  it('verifies a genuine ES384 signature over the document', async () => {
    // The `Sig_structure` is hand-encoded in the verifier; the fixture's was encoded by
    // Python's cbor2. Agreement between two independent encoders is the real assertion here.
    const cose = parseAttestationDocument(TEST_DOCUMENT);
    const { leaf } = chainOf(TEST_DOCUMENT);

    expect(await verifyCoseSignature(cose, leaf)).toBe(true);
  });

  it('rejects a document whose module_id was changed after signing', async () => {
    const tampered = tamperAfter(TEST_DOCUMENT, 'module_id', 2);
    const cose = parseAttestationDocument(tampered);
    const { leaf } = chainOf(tampered);

    expect(cose.attestationDoc.module_id).not.toBe('i-0test-tpm');
    expect(await verifyCoseSignature(cose, leaf)).toBe(false);
  });

  it('rejects a document whose PCR values were changed after signing', async () => {
    // The attack the pinned-PCR comparison alone could not detect: edit the measurements and
    // the numbers on screen change with nothing to contradict them.
    const tampered = tamperAfter(TEST_DOCUMENT, 'nitrotpm_pcrs', 8);
    const cose = parseAttestationDocument(tampered);
    const { leaf } = chainOf(tampered);

    expect(await verifyCoseSignature(cose, leaf)).toBe(false);
  });

  it('rejects a signature verified against the wrong certificate', async () => {
    const cose = parseAttestationDocument(TEST_DOCUMENT);
    const { leaf } = chainOf(IMPOSTOR_DOCUMENT);

    expect(await verifyCoseSignature(cose, leaf)).toBe(false);
  });

  it('refuses a protected header whose algorithm disagrees with the key', async () => {
    const cose = parseAttestationDocument(ALG_CONFUSION_DOCUMENT);
    const { leaf } = chainOf(ALG_CONFUSION_DOCUMENT);

    await expect(verifyCoseSignature(cose, leaf)).rejects.toThrow(
      /COSE algorithm -7 expects P-256 but the leaf certificate key is P-384/,
    );
  });
});

describe('inspectAttestationDocument, the public entry point', () => {
  it('takes no anchor argument and refuses a document outside the AWS PKI', async () => {
    // There is no parameter to relax and no environment variable to set: the exported API
    // always uses the pinned root. A synthetic chain cannot be talked into verifying.
    const result = await inspectAttestationDocument(TEST_DOCUMENT, TEST_NONCE);

    expect(result.verified).toBe(false);
    expect(result.chain_verified).toBe(false);
    expect(result.signature_verified).toBe(false);
    expect(result.error).toMatch(/No path to the pinned AWS Nitro root CA/);
  });

  it('refuses the impostor document despite its AWS-identical DNs', async () => {
    const result = await inspectAttestationDocument(IMPOSTOR_DOCUMENT, TEST_NONCE);

    expect(result.verified).toBe(false);
    expect(result.chain_verified).toBe(false);
    expect(result.error).toMatch(/signature does not verify under the pinned root key/);
  });

  it('still reports the certificates and PCRs it rejected', async () => {
    // A refusal has to stay legible: the operator needs to see which chain was presented.
    const result = await inspectAttestationDocument(TEST_DOCUMENT, TEST_NONCE);

    expect(result.certificate_chain_present).toBe(true);
    expect(result.certificates?.map((c) => c.subject)).toEqual([
      'CN=i-0test-tpm.us-east-1.aws,OU=TEST,O=Test,C=US',
      'CN=test.root.invalid,OU=TEST,O=Test,C=US',
      'CN=test.intermediate.invalid,OU=TEST,O=Test,C=US',
    ]);
    expect(Object.keys(result.attestation_document?.pcrs || {})).toEqual(['0', '1', '2', '4', '8']);
  });

  it('reports the nonce independently of the cryptographic verdict', async () => {
    // nonce_verified says the document answers *this* request; it says nothing about whether
    // the document is genuine. Folding the two together is how a fresh forgery gets accepted.
    const matched = await inspectAttestationDocument(TEST_DOCUMENT, TEST_NONCE);
    expect(matched.nonce_verified).toBe(true);
    expect(matched.verified).toBe(false);

    const wrong = await inspectAttestationDocument(TEST_DOCUMENT, 'some-other-nonce');
    expect(wrong.nonce_verified).toBe(false);
  });
});
