import type { RaiFlowClient } from '../client.js';

export interface WorkGenerateResult {
  work: string;
}

/**
 * Work generation for non-custodial flows and thin client-side wallets.
 *
 * Use this when your app builds blocks client-side (e.g., a browser wallet)
 * and needs PoW without configuring a separate work provider. RaiFlow
 * generates work at the current network difficulty automatically.
 */
export class WorkResource {
  constructor(private client: RaiFlowClient) {}

  async generate(hash: string, difficulty?: string, blockType?: 'send' | 'receive'): Promise<WorkGenerateResult> {
    return this.client.request<WorkGenerateResult>('POST', '/work', { hash, difficulty, blockType });
  }
}
