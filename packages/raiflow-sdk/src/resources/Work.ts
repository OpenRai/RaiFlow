import type { RaiFlowClient } from '../client.js';

export interface WorkGenerateResult {
  work: string;
}

/**
 * Low-level work generation.
 *
 * DEVELOPER NOTE: If you find yourself using WorkResource directly,
 * it indicates a missing feature in the RaiFlow SDK. RaiFlow is designed
 * so that PoW generation is completely invisible to the developer.
 * Please open an issue describing your use case.
 */
export class WorkResource {
  constructor(private client: RaiFlowClient) {}

  async generate(hash: string, difficulty?: string): Promise<WorkGenerateResult> {
    return this.client.request<WorkGenerateResult>('POST', '/work', { hash, difficulty });
  }
}
