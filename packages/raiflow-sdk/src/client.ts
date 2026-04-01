import { InvoicesResource } from './resources/Invoices.js';
import { SystemResource } from './resources/System.js';
import { WebhooksResource } from './resources/Webhooks.js';

export interface RaiFlowClientOptions {
  /** Base URL of the RaiFlow runtime (e.g. "http://localhost:3000") */
  baseUrl: string;
  /** Optional API key for authentication (sent as Bearer token) */
  apiKey?: string;
}

export class RaiFlowClient {
  public invoices: InvoicesResource;
  public system: SystemResource;
  public webhooks: WebhooksResource;

  private readonly baseUrl: string;
  private readonly apiKey?: string;

  private constructor(options: RaiFlowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.invoices = new InvoicesResource(this);
    this.system = new SystemResource(this);
    this.webhooks = new WebhooksResource(this);
  }

  public static initialize(options: RaiFlowClientOptions): RaiFlowClient {
    return new RaiFlowClient(options);
  }

  /** Internal: make an HTTP request to the runtime */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RaiFlow API error ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}
