import type { RaiFlowClient } from '../client.js';

export interface RuntimeHealth {
  status: string;
}

export class SystemResource {
  constructor(private client: RaiFlowClient) {}

  public async health(): Promise<RuntimeHealth> {
    return this.client.request<RuntimeHealth>('GET', '/health');
  }
}
