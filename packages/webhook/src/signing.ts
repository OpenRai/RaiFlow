// @openrai/webhook — HMAC-SHA256 signing & verification
// Signature format: t=<unix_timestamp>,v1=<hex_hmac>

import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sign a webhook payload.
 * Returns a signature header value in the form: `t=<unix_timestamp>,v1=<hex_hmac>`
 */
export function signPayload(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${payload}`;
  const hmac = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${t},v1=${hmac}`;
}

/**
 * Verify a webhook signature header.
 * Returns `true` if the signature is valid and within the timestamp tolerance.
 *
 * @param payload     - Raw request body string
 * @param signature   - Value of the `X-RaiFlow-Signature` header
 * @param secret      - Endpoint secret used to verify
 * @param toleranceMs - Max age of the timestamp in ms (default: 5 minutes). Pass 0 to disable.
 */
export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): boolean {
  // Parse t= and v1= parts
  const parts: Record<string, string> = {};
  for (const part of signature.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) return false;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key && value) parts[key] = value;
  }

  const tStr = parts['t'];
  const v1 = parts['v1'];
  if (!tStr || !v1) return false;

  const t = parseInt(tStr, 10);
  if (!Number.isFinite(t)) return false;

  // Timestamp tolerance check (prevent replay attacks)
  if (toleranceMs > 0) {
    const ageMs = Date.now() - t * 1000;
    if (ageMs > toleranceMs || ageMs < -toleranceMs) return false;
  }

  // Reconstruct expected HMAC
  const signedPayload = `${t}.${payload}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Timing-safe comparison (both buffers must be same length)
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(v1, 'utf8');

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
