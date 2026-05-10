import type { RaiFlowClient } from '../client.js';

export interface RuntimeHealth {
  status: string;
}

export interface RuntimeVersion {
  version: string;
}

export interface SdkVersion {
  runtimeVersion: string;
  sdkVersion: string;
}

export class SystemResource {
  constructor(private client: RaiFlowClient) {}

  public async health(): Promise<RuntimeHealth> {
    return this.client.request<RuntimeHealth>('GET', '/health');
  }

  public async version(): Promise<RuntimeVersion> {
    return this.client.request<RuntimeVersion>('GET', '/version');
  }
}
