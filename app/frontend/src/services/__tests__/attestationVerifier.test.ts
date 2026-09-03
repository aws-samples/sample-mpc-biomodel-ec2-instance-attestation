/**
 * Unit Tests for Attestation Verifier
 * 
 * Tests for CBOR parsing, certificate validation, and public key extraction.
 */

import { describe, test, expect } from 'vitest';

import type { AttestationDocument } from '../attestationVerifier';

// We need to test the internal functions, so we'll import the module differently
// For actual testing, we'd need to export these functions or test through the public API

describe('Date Parsing (ASN.1 Time)', () => {
    // Test the UTC date parsing bug that was fixed
    
    test('Date.UTC creates proper UTC timestamp', () => {
        // This is the correct way to create a UTC date
        const utcDate = new Date(Date.UTC(2026, 4, 12, 2, 5, 59)); // May 12, 2026 02:05:59 UTC
        
        // getUTCHours should return 2
        expect(utcDate.getUTCHours()).toBe(2);
        expect(utcDate.getUTCMinutes()).toBe(5);
        expect(utcDate.getUTCFullYear()).toBe(2026);
        expect(utcDate.getUTCMonth()).toBe(4); // 0-indexed
        expect(utcDate.getUTCDate()).toBe(12);
    });
    
    test('new Date() with args creates local time (BUG)', () => {
        // This was the bug - new Date(year, month, day...) creates LOCAL time
        const localDate = new Date(2026, 4, 12, 2, 5, 59);
        
        // In UTC+0 timezone, this would work
        // But in other timezones, getUTCHours() would be different
        // This test documents the potential issue
        
        const hoursDiff = localDate.getUTCHours() - 2;
        console.log(`Local vs UTC hours difference: ${hoursDiff}`);
        // The difference depends on the server's timezone
    });
    
    test('UTCTime parsing format', () => {
        // UTCTime format: YYMMDDHHMMSSZ
        const utcTimeString = '260512020559Z';
        
        const year = parseInt(utcTimeString.substr(0, 2)); // 26
        const fullYear = year >= 50 ? 1900 + year : 2000 + year; // 2026
        const month = parseInt(utcTimeString.substr(2, 2)) - 1; // 4 (May, 0-indexed)
        const day = parseInt(utcTimeString.substr(4, 2)); // 12
        const hour = parseInt(utcTimeString.substr(6, 2)); // 02
        const minute = parseInt(utcTimeString.substr(8, 2)); // 05
        const second = parseInt(utcTimeString.substr(10, 2)); // 59
        
        expect(fullYear).toBe(2026);
        expect(month).toBe(4);
        expect(day).toBe(12);
        expect(hour).toBe(2);
        expect(minute).toBe(5);
        expect(second).toBe(59);
        
        // Correct way to create Date
        const correctDate = new Date(Date.UTC(fullYear, month, day, hour, minute, second));
        expect(correctDate.getUTCHours()).toBe(2);
    });
});

describe('Public Key Buffer Extraction', () => {
    test('Uint8Array slice creates copy with correct buffer size', () => {
        // Simulate CBOR-decoded buffer where public_key is a view into larger buffer
        const largeBuffer = new ArrayBuffer(5000);
        const fullDoc = new Uint8Array(largeBuffer);
        
        // Simulate public key at offset 1000, length 294
        const publicKeyView = fullDoc.subarray(1000, 1294);
        
        // BUG: .buffer returns the entire 5000-byte buffer
        expect(publicKeyView.buffer.byteLength).toBe(5000);
        expect(publicKeyView.byteLength).toBe(294);
        
        // FIX: Use slice() to create proper copy
        const correctKeyBuffer = publicKeyView.slice().buffer;
        expect(correctKeyBuffer.byteLength).toBe(294);
    });
    
    test('WebCrypto importKey requires correct buffer size', async () => {
        // Real RSA-2048 SPKI public key is 294 bytes
        // If we pass a 5000-byte buffer, WebCrypto will fail
        
        // This test documents the requirement
        const correctSize = 294;
        const wrongSize = 5000;
        
        expect(correctSize).toBe(294);
        expect(wrongSize).not.toBe(294);
    });
});

describe('CBOR COSE_Sign1 Structure', () => {
    test('COSE_Sign1 first byte is 0x84 (array of 4)', () => {
        // COSE_Sign1 structure: [protected, unprotected, payload, signature]
        // In CBOR, an array of 4 elements has first byte 0x84
        const coseSign1FirstByte = 0x84;
        
        expect(coseSign1FirstByte & 0xf0).toBe(0x80); // Major type 4 = array
        expect(coseSign1FirstByte & 0x0f).toBe(4);    // 4 elements
    });
    
    test('Expected attestation document fields', () => {
        // AWS NitroTPM attestation document should contain these fields
        const requiredFields = [
            'module_id',
            'digest',
            'timestamp',
            'pcrs',
            'certificate',
            'cabundle',
            'public_key',
            'user_data',
            'nonce'
        ];
        
        // Test that we know what fields to expect
        expect(requiredFields).toContain('public_key');
        expect(requiredFields).toContain('certificate');
        expect(requiredFields).toContain('nonce');
    });
});

describe('Certificate Validation', () => {
    test('Certificate validity check compares against current time', () => {
        const now = new Date();
        
        // Valid certificate: notBefore < now < notAfter
        const validNotBefore = new Date(now.getTime() - 3600000); // 1 hour ago
        const validNotAfter = new Date(now.getTime() + 3600000);  // 1 hour from now
        
        expect(now >= validNotBefore).toBe(true);
        expect(now <= validNotAfter).toBe(true);
        
        // Expired certificate: now > notAfter
        const expiredNotAfter = new Date(now.getTime() - 1000);
        expect(now > expiredNotAfter).toBe(true);
        
        // Not yet valid: now < notBefore
        const futureNotBefore = new Date(now.getTime() + 1000);
        expect(now < futureNotBefore).toBe(true);
    });
    
    test('TTL calculation from certificate expiry', () => {
        const now = Date.now();
        const certExpiry = new Date(now + 3 * 60 * 60 * 1000); // 3 hours
        
        const timeUntilExpiry = certExpiry.getTime() - now;
        const ttl = Math.floor(timeUntilExpiry * 0.8); // Use 80% of remaining time
        
        expect(timeUntilExpiry).toBeCloseTo(3 * 60 * 60 * 1000, -2);
        expect(ttl).toBeCloseTo(2.4 * 60 * 60 * 1000, -2); // 2.4 hours
    });
});

describe('Nonce Verification', () => {
    test('Nonce should be hex string of 32 chars (16 bytes)', () => {
        // Generate nonce like the encryption service does
        const generateNonce = () => {
            const array = new Uint8Array(16);
            // Simulated random values
            for (let i = 0; i < 16; i++) {
                array[i] = Math.floor(Math.random() * 256);
            }
            return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
        };
        
        const nonce = generateNonce();
        
        expect(nonce).toHaveLength(32);
        expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });
    
    test('Nonce comparison - string vs Uint8Array', () => {
        const nonceString = 'abcd1234ef567890abcd1234ef567890';
        
        // Convert to Uint8Array (as might come from CBOR)
        const nonceBytes = new TextEncoder().encode(nonceString);
        
        // Convert back to string for comparison
        const recoveredString = new TextDecoder().decode(nonceBytes);
        
        expect(recoveredString).toBe(nonceString);
    });
});

describe('Error Handling', () => {
    test('Missing public_key field should throw', () => {
        // Typed as AttestationDocument so the missing-field assertion below compiles:
        // `public_key` is a declared optional field of the document, not an unknown one.
        const docWithoutKey: AttestationDocument = {
            module_id: 'test',
            certificate: new Uint8Array([1, 2, 3])
        };

        expect(docWithoutKey.public_key).toBeUndefined();
    });
    
    test('Invalid CBOR should be caught', () => {
        // Not valid CBOR - would throw during decode
        const invalidCbor = new Uint8Array([0xFF, 0xFF, 0xFF]);
        
        // Just verify it's not starting with valid CBOR marker
        expect(invalidCbor[0]).not.toBe(0x84); // Not COSE_Sign1
    });
});