// @openrai/webhook — HMAC-SHA256 signing & verification
// Signature format: sha256=<hex_hmac>

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign a webhook payload.
 * Returns a signature header value in the form: `sha256=<hex_hmac>`.
 */
export function signPayload(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Verify a webhook signature header.
 * Returns `true` when the signature matches the exact raw request body.
 *
 * @param payload     - Raw request body string
 * @param signature   - Value of the `X-RaiFlow-Signature` header
 * @param secret      - Endpoint secret used to verify
 */
export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const actual = signature.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // Timing-safe comparison (both buffers must be same length)
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
