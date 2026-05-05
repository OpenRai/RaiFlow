import type { RaiFlowClient } from '../client.js';

export interface PublishBlockResult {
  hash: string;
}

/**
 * Low-level block publishing for pre-signed blocks.
 *
 * DEVELOPER NOTE: This resource exists for advanced non-custodial flows
 * where blocks are signed client-side (e.g., in a browser wallet).
 * For custodial flows, use SendsResource — RaiFlow handles signing and
 * PoW automatically.
 */
export class BlocksResource {
  constructor(private client: RaiFlowClient) {}

  async publish(block: string): Promise<PublishBlockResult> {
    return this.client.request<PublishBlockResult>('POST', '/blocks', { block });
  }
}
