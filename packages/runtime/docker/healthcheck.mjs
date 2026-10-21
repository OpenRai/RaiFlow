#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

/**
 * Docker liveness probe for the RaiFlow HTTP process.
 *
 * Liveness deliberately checks only the loopback runtime.  Nano RPC and
 * custody readiness belong to /health/ready; an upstream outage must not make
 * Docker restart an otherwise responsive RaiFlow process.
 */
export async function probeHealth(
  url = process.env.RAIFLOW_HEALTH_URL ?? 'http://127.0.0.1:3100/health/live',
  timeoutMs = Number(process.env.RAIFLOW_HEALTH_TIMEOUT_MS ?? 5_000),
  fetchImpl = fetch,
) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await probeHealth()) ? 0 : 1;
}
