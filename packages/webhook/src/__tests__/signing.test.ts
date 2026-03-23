import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signPayload, verifySignature } from '../signing.js';

describe('signPayload', () => {
  it('returns a string in format t=<timestamp>,v1=<hex>', () => {
    const sig = signPayload('hello', 'secret');
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('includes a recent unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const sig = signPayload('payload', 'secret');
    const after = Math.floor(Date.now() / 1000);

    const tPart = sig.split(',')[0];
    expect(tPart).toBeDefined();
    const t = parseInt(tPart!.slice(2), 10);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signPayload('payload', 'secret1');
    const sig2 = signPayload('payload', 'secret2');
    const v1_1 = sig1.split(',v1=')[1];
    const v1_2 = sig2.split(',v1=')[1];
    expect(v1_1).not.toBe(v1_2);
  });
});

describe('verifySignature', () => {
  it('returns true for a freshly signed payload', () => {
    const payload = 'hello world';
    const secret = 'my-secret';
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it('returns false for tampered payload', () => {
    const secret = 'my-secret';
    const sig = signPayload('original payload', secret);
    expect(verifySignature('tampered payload', sig, secret)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const payload = 'hello';
    const sig = signPayload(payload, 'correct-secret');
    expect(verifySignature(payload, sig, 'wrong-secret')).toBe(false);
  });

  it('returns false for expired timestamp (with small tolerance)', () => {
    const payload = 'hello';
    const secret = 'secret';
    // Timestamp 10 minutes in the past
    const staleT = Math.floor(Date.now() / 1000) - 600;
    const hmac = createHmac('sha256', secret)
      .update(`${staleT}.${payload}`)
      .digest('hex');
    const staleSig = `t=${staleT},v1=${hmac}`;

    // 5-minute tolerance — should be rejected
    expect(verifySignature(payload, staleSig, secret, 5 * 60 * 1000)).toBe(false);
  });

  it('returns true within tolerance window', () => {
    const payload = 'hello';
    const secret = 'secret';
    // Timestamp 2 minutes in the past
    const recentT = Math.floor(Date.now() / 1000) - 120;
    const hmac = createHmac('sha256', secret)
      .update(`${recentT}.${payload}`)
      .digest('hex');
    const recentSig = `t=${recentT},v1=${hmac}`;

    // 5-minute tolerance — should be accepted
    expect(verifySignature(payload, recentSig, secret, 5 * 60 * 1000)).toBe(true);
  });

  it('returns false for malformed signature (no t= or v1=)', () => {
    expect(verifySignature('payload', 'invalid-sig', 'secret')).toBe(false);
    expect(verifySignature('payload', 't=123', 'secret')).toBe(false);
    expect(verifySignature('payload', 'v1=abc', 'secret')).toBe(false);
    expect(verifySignature('payload', '', 'secret')).toBe(false);
  });

  it('returns false for non-finite timestamp', () => {
    expect(verifySignature('payload', 't=NaN,v1=abc', 'secret')).toBe(false);
    expect(verifySignature('payload', 't=abc,v1=abc', 'secret')).toBe(false);
  });

  it('does not throw when using timing-safe comparison', () => {
    const payload = 'safe';
    const secret = 'secret';
    const sig = signPayload(payload, secret);
    expect(() => verifySignature(payload, sig, secret)).not.toThrow();
  });

  it('round-trip: sign → verify works for empty string payload', () => {
    const secret = 'empty-test';
    const sig = signPayload('', secret);
    expect(verifySignature('', sig, secret)).toBe(true);
  });

  it('round-trip: sign → verify works for JSON payload', () => {
    const secret = 'json-secret';
    const payload = JSON.stringify({ event: 'invoice.created', id: '123' });
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it('round-trip: sign → verify works for unicode payload', () => {
    const secret = 'unicode-secret';
    const payload = '日本語テスト 🎉 emoji payload';
    const sig = signPayload(payload, secret);
    expect(verifySignature(payload, sig, secret)).toBe(true);
  });

  it('returns true when toleranceMs=0 (replay protection disabled)', () => {
    // toleranceMs=0 disables the timestamp check — old sigs should be accepted
    const payload = 'old-payload';
    const secret = 'secret';
    const oldT = Math.floor(Date.now() / 1000) - 9999;
    const hmac = createHmac('sha256', secret)
      .update(`${oldT}.${payload}`)
      .digest('hex');
    const oldSig = `t=${oldT},v1=${hmac}`;

    expect(verifySignature(payload, oldSig, secret, 0)).toBe(true);
  });
});
