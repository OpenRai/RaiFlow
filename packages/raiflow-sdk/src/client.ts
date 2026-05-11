import { AccountsResource } from './resources/Accounts.js';
import { BlocksResource } from './resources/Blocks.js';
import { InvoicesResource } from './resources/Invoices.js';
import { SendsResource } from './resources/Sends.js';
import { SystemResource } from './resources/System.js';
import { WebhooksResource } from './resources/Webhooks.js';
import { WorkResource } from './resources/Work.js';
import { SseConnection } from './sse-connection.js';

export interface RaiFlowClientOptions {
  /** Base URL of the RaiFlow runtime (e.g. "http://localhost:3000") */
  baseUrl: string;
  /** API key for authentication (sent as Bearer token) */
  apiKey: string;
  /** Base path for all API requests. Default: "/api" */
  basePath?: string;
}

export class RaiFlowClient {
  public accounts: AccountsResource;
  public blocks: BlocksResource;
  public invoices: InvoicesResource;
  public sends: SendsResource;
  public system: SystemResource;
  public webhooks: WebhooksResource;
  public work: WorkResource;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly basePath: string;
  private _sseConnection?: SseConnection;

  private constructor(options: RaiFlowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.basePath = options.basePath ?? '/api';
    this.accounts = new AccountsResource(this);
    this.blocks = new BlocksResource(this);
    this.invoices = new InvoicesResource(this);
    this.sends = new SendsResource(this);
    this.system = new SystemResource(this);
    this.webhooks = new WebhooksResource(this);
    this.work = new WorkResource(this);
  }

  public static initialize(options: RaiFlowClientOptions): RaiFlowClient {
    return new RaiFlowClient(options);
  }

  /** Internal: lazy-initialized SSE connection */
  get sseConnection(): SseConnection {
    if (!this._sseConnection) {
      this._sseConnection = new SseConnection(this.baseUrl, this.apiKey);
    }
    return this._sseConnection;
  }

  /** Internal: make an HTTP request to the runtime */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${this.basePath}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
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
