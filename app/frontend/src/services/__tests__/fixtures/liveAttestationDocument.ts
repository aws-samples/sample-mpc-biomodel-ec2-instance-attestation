/**
 * A real NitroTPM v2.0 attestation document, captured from the deployed instance.
 *
 * Everything else the verifier is tested against is a fixture this repository generated. This is
 * the article itself: fetched with `GET /prod/attestation?nonce=...` from instance
 * i-000fa553dad58a9f1 in us-west-2 on 2026-08-13, running the AMI the pipeline built. SHA-256 of
 * the decoded COSE_Sign1 bytes:
 *   dd6d8af26c8d574996f50b2c610adc37cfaa62f8bbf4d9b651496210af1867c2
 *
 * It is worth more than every synthetic fixture combined, because it is the only thing that can
 * confirm the pinned anchor is the *right* anchor. It is: the chain below terminates at
 * CN=aws.nitro-enclaves, the certificate in `awsNitroRootCa.ts`, and the document's ES384
 * signature verifies against the TPM leaf's key.
 *
 * THE CLOCK MUST BE PINNED TO USE THIS. The TPM leaf certificate is valid for three hours
 * (17:36:45Z to 20:36:48Z) and the instance certificate for one day — AWS issues them per boot,
 * not per decade. A test that lets the real clock run would pass for one afternoon and then fail
 * forever, blaming the verifier for the calendar. `CAPTURED_AT_MS` is the document's own
 * timestamp; set it with `vi.setSystemTime` before verifying.
 *
 * Nothing here is secret. The certificates are public AWS-issued ones, the public key is a public
 * key, and this AMI's PCRs are already published in the README. The nonce was generated for this
 * one fetch: replaying the document elsewhere requires matching a nonce the verifier chose, which
 * is the whole point of it.
 *
 * Observed shape, recorded because it is what a real document looks like rather than what the
 * documentation implies:
 *   - The payload map is CBOR indefinite-length (0xbf), not definite.
 *   - `nitrotpm_pcrs` keys are CBOR integers, not strings, and all 24 registers are present.
 *     Non-zero: 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 17, 18, 19, 20, 21, 22.
 *   - `cabundle` carries the root itself, at index 0 — root-first, not root-last. The verifier
 *     ignores it and uses the pinned copy; a document supplying its own trust anchor is the
 *     attack, not the mechanism.
 *   - The chain is five certificates deep: TPM leaf, instance, zonal, regional, root.
 *   - `user_data` is null, and the bound `public_key` is a 91-byte EC P-256 SPKI (the HPKE
 *     recipient key), not RSA.
 */

/** The nonce that was sent with the request this document answers. */
export const LIVE_NONCE = 'be4c5b7d743ff7808cf107a64a8de6d907823adccef58c366d3d4cc6a2b2f767';

/** The document's own timestamp, inside every certificate's validity window. */
export const CAPTURED_AT_MS = 1786642608432;

/** Subject DNs from leaf to anchor, as `verifyCertificateChain` reports them. */
export const LIVE_CHAIN_PATH = [
  'CN=i-000fa553dad58a9f1-tpm0000000000000000.us-west-2.aws,OU=AWS,O=Amazon,L=Seattle,ST=Washington,C=US',
  'CN=i-000fa553dad58a9f1.us-west-2.aws.nitro-enclaves,OU=AWS,O=Amazon,L=Seattle,ST=Washington,C=US',
  'L=Seattle,ST=WA,C=US,O=Amazon,OU=AWS,CN=529189572cc01ee0.zonal.us-west-2.aws.nitro-enclaves',
  'CN=280d3d43ef972f09.us-west-2.aws.nitro-enclaves,OU=AWS,O=Amazon,C=US',
  'CN=aws.nitro-enclaves,OU=AWS,O=Amazon,C=US',
];

/** Base64 of the raw COSE_Sign1 document, exactly as the endpoint returned it. */
export const LIVE_ATTESTATION_DOCUMENT_BASE64 =
  'hEShATgioFkTMr9pbW9kdWxlX2lkeCdpLTAwMGZhNTUzZGFkNThhOWYxLXRwbTAwMDAwMDAwMDAwMDAwMDBmZGlnZXN0ZlNIQTM4NGl0aW1l' +
  'c3RhbXAbAAABn/wysTBtbml0cm90cG1fcGNyc7gYAFgwbpAbFpMvbgNnR9eldpbkosyGQAjrwBaCbKHXvUKrWsgobM9JzebAKEy8S2PZeKLs' +
  'AVgwiA4liX+IBSgAQwRPSpoLxFcVceQgTs+k4Y3eXSVMHuk0JF3Ah4hYrDcwUkQCnvfNAlgwUYkjsPlV0I2gd8lqq6Uiud7O3mHFmc6mxBiJ' +
  'z76krk1QUp2W/k0a/a+2Xn+VvyPEA1gwUYkjsPlV0I2gd8lqq6Uiud7O3mHFmc6mxBiJz76krk1QUp2W/k0a/a+2Xn+VvyPEBFgwPEKNr2Oa' +
  'hmVcvorv8e6ymPWcaoLY6m/cNMbzrx0lgvCRolrKSm85DDLw93AZUoKaBVgwZuwmV1N5l3IbmKYs5G8CMBSsrkEHFeFoQOLKFCuymgnJ2eeG' +
  'm7JrdSi2mg3V+4ZOBlgwUYkjsPlV0I2gd8lqq6Uiud7O3mHFmc6mxBiJz76krk1QUp2W/k0a/a+2Xn+VvyPEB1gwmEQcf3Yl0QBYxHaDrsSG' +
  'zjEcYzI161VVk6fueREh41eK5y0E7O9mHyctWQWLd681CFgwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAACVgwb1I2BqbVZTLYAmeGsfj1OT8H/d9XfxYwUV3mlwPmGvLsU4vGqTAUZkYKigpH3MehClgw1G0xaM9fF9TvW0/RWZGNU8SNRxdH8XUl' +
  'nxp8gOwFDZn/5Wmi5YRK4CQmTeJacBEhC1gwcwPxRjV8/PtyJL2RWeCQh3gY8MP4RdkaLuOiPyfDBoKRrbLQE7OegfABMlKIrgzgDFgwAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADVgwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAADlgwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD1gwAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEFgwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAEVgw////////////////////////////////////////////////////////////////Elgw////////////////////////////' +
  '////////////////////////////////////E1gw////////////////////////////////////////////////////////////////FFgw' +
  '////////////////////////////////////////////////////////////////FVgw////////////////////////////////////////' +
  '////////////////////////Flgw////////////////////////////////////////////////////////////////F1gwAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa2NlcnRpZmljYXRlWQJzMIICbzCCAfWgAwIBAgIEan4AsDAKBggqhkjO' +
  'PQQDAzCBjjELMAkGA1UEBhMCVVMxEzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxDzANBgNVBAoMBkFtYXpvbjEMMAoG' +
  'A1UECwwDQVdTMTkwNwYDVQQDDDBpLTAwMGZhNTUzZGFkNThhOWYxLnVzLXdlc3QtMi5hd3Mubml0cm8tZW5jbGF2ZXMwHhcNMjYwODEzMTcz' +
  'NjQ1WhcNMjYwODEzMjAzNjQ4WjCBkzELMAkGA1UEBhMCVVMxEzARBgNVBAgMCldhc2hpbmd0b24xEDAOBgNVBAcMB1NlYXR0bGUxDzANBgNV' +
  'BAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMT4wPAYDVQQDDDVpLTAwMGZhNTUzZGFkNThhOWYxLXRwbTAwMDAwMDAwMDAwMDAwMDAudXMtd2Vz' +
  'dC0yLmF3czB2MBAGByqGSM49AgEGBSuBBAAiA2IABAquMoUgkCcIoMQS3GdBk0bxx4BMbVKfEosdT6q0lk9ioEOI9E2V150KC403eoXhkiC3' +
  'sdnan1Nsz1aGQrXLb1zGIdgsNJSI+ZOD8odGz/3Lx8k3RpzfTYEyFMBNs5pHjKMdMBswDAYDVR0TAQH/BAIwADALBgNVHQ8EBAMCBsAwCgYI' +
  'KoZIzj0EAwMDaAAwZQIxAIYtH2f8iwV634pRZSMXYTyEm+d6h+xuCqua0gJ0OnmLJlDdL9JlByOAtRv2PyjCgQIwJtRgwDDTc4DP5kW7tf1Y' +
  'ZveybhGjKieg4rrUTYe/1y1/awCSqsocEDCZ8mzL/OD9aGNhYnVuZGxlhFkCFTCCAhEwggGWoAMCAQICEQD5MXVoG5Cv4R1GzLTk5/hWMAoG' +
  'CCqGSM49BAMDMEkxCzAJBgNVBAYTAlVTMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsMA0FXUzEbMBkGA1UEAwwSYXdzLm5pdHJvLWVuY2xh' +
  'dmVzMB4XDTE5MTAyODEzMjgwNVoXDTQ5MTAyODE0MjgwNVowSTELMAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdT' +
  'MRswGQYDVQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT8AlTrpgjB82hw4prakL5GODKSc26JS//2ctmJ' +
  'REtQUeU0pLH22+PAvFgaMrexdgcO3hLWmj/qIRtm51LPfdHdCV9vE3D0FwhD2dwQASHkz2MBKAlmRIfJeWKEME3FP/SjQjBAMA8GA1UdEwEB' +
  '/wQFMAMBAf8wHQYDVR0OBBYEFJAltQ3ZBUfnlsOW+nKdz5mp30uWMA4GA1UdDwEB/wQEAwIBhjAKBggqhkjOPQQDAwNpADBmAjEAo38vkaHJ' +
  'vV7nuGJ8FpjSVQOOHwND+VtjqWKMPTmAlUWhHry/LjtV2K7ucbTD1q3zAjEAovObFgWycCil3UugabUBbmW0+96P4AYdalMZf5za9dlDvGH8' +
  'K+sDy2/ujSMC89/2WQLCMIICvjCCAkSgAwIBAgIQM4Ns+3gHJ3ilc37/iSVnCjAKBggqhkjOPQQDAzBJMQswCQYDVQQGEwJVUzEPMA0GA1UE' +
  'CgwGQW1hem9uMQwwCgYDVQQLDANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczAeFw0yNjA4MTIxNDIzMjBaFw0yNjA5MDExNTIz' +
  'MjBaMGQxCzAJBgNVBAYTAlVTMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsMA0FXUzE2MDQGA1UEAwwtMjgwZDNkNDNlZjk3MmYwOS51cy13' +
  'ZXN0LTIuYXdzLm5pdHJvLWVuY2xhdmVzMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE/KFe0in8yfF2ELGzZvhUBvvynSmdI6eJBmp2Q0y4RxJr' +
  'gCgBFR0CYpmyi9IMePIzAW5cXEXHtqFaBAUO2xTYZwt1jC6BVyrURwuBhzIeHyzxvSWbsXd9/TxVcH6xaVv9o4HVMIHSMBIGA1UdEwEB/wQI' +
  'MAYBAf8CAQIwHwYDVR0jBBgwFoAUkCW1DdkFR+eWw5b6cp3PmanfS5YwHQYDVR0OBBYEFACIOthfAM19acHLAh8jnfAU1ec7MA4GA1UdDwEB' +
  '/wQEAwIBhjBsBgNVHR8EZTBjMGGgX6BdhltodHRwOi8vYXdzLW5pdHJvLWVuY2xhdmVzLWNybC5zMy5hbWF6b25hd3MuY29tL2NybC9hYjQ5' +
  'NjBjYy03ZDYzLTQyYmQtOWU5Zi01OTMzOGNiNjdmODQuY3JsMAoGCCqGSM49BAMDA2gAMGUCMQD4YF9MYtY1kXz7lhBwvxjCJbNtrhiRVI8a' +
  '0UnEpBBMNRRgosnJSkMX8t+7lzva2PYCMBLqrT3wDWUoUpjPs77ebS7HTmtNx7XOKVsJyTwVlFam2VIM5SmyPIa8cDK1eDEn3FkDGTCCAxUw' +
  'ggKboAMCAQICEQD9pgAIADGu6Q0ChbINnStQMAoGCCqGSM49BAMDMGQxCzAJBgNVBAYTAlVTMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsM' +
  'A0FXUzE2MDQGA1UEAwwtMjgwZDNkNDNlZjk3MmYwOS51cy13ZXN0LTIuYXdzLm5pdHJvLWVuY2xhdmVzMB4XDTI2MDgxMzEwMzg0M1oXDTI2' +
  'MDgxOTA0Mzg0M1owgYkxPDA6BgNVBAMMMzUyOTE4OTU3MmNjMDFlZTAuem9uYWwudXMtd2VzdC0yLmF3cy5uaXRyby1lbmNsYXZlczEMMAoG' +
  'A1UECwwDQVdTMQ8wDQYDVQQKDAZBbWF6b24xCzAJBgNVBAYTAlVTMQswCQYDVQQIDAJXQTEQMA4GA1UEBwwHU2VhdHRsZTB2MBAGByqGSM49' +
  'AgEGBSuBBAAiA2IABOglyLsvePmbdSZsQiE6fiKcvmO/tTrL85hVHBXlP7cpnuo94rVI5aVH20mNxh+VYlsO9jMPkeGRSnwDSHucMxKMAJg1' +
  'jZLg2si5qwJw95Q89OGaeG8m5qJb5wvAgS8GNqOB6jCB5zASBgNVHRMBAf8ECDAGAQH/AgEBMB8GA1UdIwQYMBaAFACIOthfAM19acHLAh8j' +
  'nfAU1ec7MB0GA1UdDgQWBBQYJGrvbowVIunrBleXsBlJr0BA7DAOBgNVHQ8BAf8EBAMCAYYwgYAGA1UdHwR5MHcwdaBzoHGGb2h0dHA6Ly9j' +
  'cmwtdXMtd2VzdC0yLWF3cy1uaXRyby1lbmNsYXZlcy5zMy51cy13ZXN0LTIuYW1hem9uYXdzLmNvbS9jcmwvOGUzOTA1YzgtMzI2YS00NWUw' +
  'LWEzYzMtYzRjZjIyNjMwY2Q2LmNybDAKBggqhkjOPQQDAwNoADBlAjBneqaWiXTucb5Ran8h6b6Z3S1vu0SUKs3C28A7/6065ULYqKlR53LI' +
  'uBs1h/AWJGsCMQDLUc3cZij26YUApiUyVwaetp8/lOsi2UJJVoD7mFQIctBJAAywKH50yAAYAIWiGLBZAsEwggK9MIICRKADAgECAhQgXaAl' +
  'IWCO3wGkGd9tFF1fF7SOvDAKBggqhkjOPQQDAzCBiTE8MDoGA1UEAwwzNTI5MTg5NTcyY2MwMWVlMC56b25hbC51cy13ZXN0LTIuYXdzLm5p' +
  'dHJvLWVuY2xhdmVzMQwwCgYDVQQLDANBV1MxDzANBgNVBAoMBkFtYXpvbjELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAldBMRAwDgYDVQQHDAdT' +
  'ZWF0dGxlMB4XDTI2MDgxMzE1MDE1OFoXDTI2MDgxNDE1MDE1OFowgY4xCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApXYXNoaW5ndG9uMRAwDgYD' +
  'VQQHDAdTZWF0dGxlMQ8wDQYDVQQKDAZBbWF6b24xDDAKBgNVBAsMA0FXUzE5MDcGA1UEAwwwaS0wMDBmYTU1M2RhZDU4YTlmMS51cy13ZXN0' +
  'LTIuYXdzLm5pdHJvLWVuY2xhdmVzMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEOS2XwLf1wWJOYwu9pjVsgD7UFLpZJef1N07P+gt5E2iTll3p' +
  'lF6ZQb/ACZRfF2ZlFJFoxhwaYEu2jf6zK02CM5o1978xvUbhqQ8Ruxu1Eie/NkPLSYmLyxQgcjy2nvVao2YwZDASBgNVHRMBAf8ECDAGAQH/' +
  'AgEAMA4GA1UdDwEB/wQEAwICBDAdBgNVHQ4EFgQUXWu/Ey9XFrF+C1kB61nGSM4C/zkwHwYDVR0jBBgwFoAUGCRq726MFSLp6wZXl7AZSa9A' +
  'QOwwCgYIKoZIzj0EAwMDZwAwZAIwGxQj64XCuL8NSWuWfgwAEdk/5wn7VhF/hsoB5TxWSp0KIU3QUDRzhuGyIKR+t9l1AjADV/xNymbCejpR' +
  '+HrLMPCVBRc6Kyy2L9xoA7N50sK3WymMSmWHAm14wN/NBy0IWuBqcHVibGljX2tleVhbMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz9yI' +
  '5ju3kpuL8vCZiTW3woiCVzGcTyxZ1XMwDbOX8aJj8RzPmojkoOeLWSXXzye3gCSmxhm+9Gt263ql/S2Rl2l1c2VyX2RhdGH2ZW5vbmNlWEBi' +
  'ZTRjNWI3ZDc0M2ZmNzgwOGNmMTA3YTY0YThkZTZkOTA3ODIzYWRjY2VmNThjMzY2ZDNkNGNjNmEyYjJmNzY3/1hgm0mXi4zy7ly8bN9aEGxZ' +
  'RCmvns5qPXVZefJsOUrdrilLgEyL1SDHBL4FSQvb2049ggFKD0o/dWf+rjN+IxxsxryMk2yKw9MUDXPm/HB+ZjdkjsiNyqPh2a3ywYkR1OMM';
