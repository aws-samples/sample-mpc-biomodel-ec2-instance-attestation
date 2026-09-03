/**
 * The AWS Nitro attestation PKI trust anchor.
 *
 * This is the root the attestation document's certificate chain must reach. Without a pinned
 * anchor, chain verification is theatre: anyone can generate a self-signed chain, and
 * verifying each link against the next only proves the forger was internally consistent.
 *
 * PROVENANCE — this matters more than the code around it, so it is recorded in full:
 *
 *   Source   https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
 *            (public, unauthenticated; AWS publishes it for exactly this purpose)
 *   Zip      SHA-256 8cf60e2b2efca96c6a9e71e851d00c1b6991cc09eadbe64a6a1d1b1eb9faff7c
 *   Cert     root.pem, 533 bytes DER
 *            SHA-256 fingerprint
 *              64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:
 *              7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B
 *   Subject  CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US  (self-signed: subject == issuer)
 *   Key      ECDSA P-384, self-signature ecdsa-with-SHA384
 *   Validity 2019-10-28 13:28:05Z .. 2049-10-28 14:28:05Z
 *
 * To re-verify, which you should do rather than trust this comment:
 *
 *   curl -sO https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
 *   shasum -a 256 AWS_NitroEnclaves_Root-G1.zip
 *   unzip -o AWS_NitroEnclaves_Root-G1.zip && openssl x509 -in root.pem -noout -fingerprint -sha256
 *
 * `attestationVerifier.test.ts` asserts the fingerprint and subject of the constant below, so
 * an edit that swaps the anchor fails the build rather than silently retargeting trust.
 *
 * WHY A CONSTANT AND NOT A FETCH: fetching the anchor at runtime would make the trust decision
 * depend on whatever the network returned, which is the problem it is supposed to solve. The
 * certificate is good until 2049, so a build-time pin costs nothing in practice.
 *
 * WHAT THIS IS NOT: an earlier version of the verifier held an `AWS_NITRO_ROOT_CA_FINGERPRINTS`
 * placeholder containing a made-up digest that nothing read. It was deleted because it
 * advertised pinning that never happened. The bytes below are the real certificate, fetched
 * from the URL above, and `verifyCertificateChain` actually verifies against them.
 *
 * NitroTPM v2.0 documents chain to this same root — the observed chain is
 * `CN=aws.nitro-enclaves` → regional → zonal → instance → TPM leaf. If AWS ever introduces a
 * separate NitroTPM anchor, verification here fails closed (no path to a pinned root) rather
 * than falling back to accepting the document.
 */

/** AWS Nitro Enclaves Root-G1, DER, base64. See the provenance block above. */
const AWS_NITRO_ROOT_CA_DER_BASE64 =
  'MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTELMAkGA1UEBhMCVVMxDzANBgNVBAoM' +
  'BkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcN' +
  'NDkxMDI4MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQLDANBV1MxGzAZBgNVBAMM' +
  'EmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEGBSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy' +
  '2YlES1BR5TSksfbb48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZEh8l5YoQwTcU/' +
  '9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkFR+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGG' +
  'MAoGCCqGSM49BAMDA2kAMGYCMQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPWrfMC' +
  'MQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6NIwLz3/Y=';

/** The pinned anchor as DER bytes. */
export function awsNitroRootCa(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(AWS_NITRO_ROOT_CA_DER_BASE64), (c) => c.charCodeAt(0));
}
