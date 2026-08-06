import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature } from '../signing.js';

describe('signPayload', () => {
  it('returns a string in format sha256=<hex>', () => {
    const sig = signPayload('hello', 'secret');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signPayload('payload', 'secret1');
    const sig2 = signPayload('payload', 'secret2');
    expect(sig1).not.toBe(sig2);
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

  it('returns false for malformed signatures', () => {
    expect(verifySignature('payload', 'invalid-sig', 'secret')).toBe(false);
    expect(verifySignature('payload', 'sha256=abc', 'secret')).toBe(false);
    expect(verifySignature('payload', '', 'secret')).toBe(false);
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

});
