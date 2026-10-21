import { AccountsResource } from './resources/Accounts.js';
import { BlocksResource } from './resources/Blocks.js';
import { InvoiceAccountsResource } from './resources/InvoiceAccounts.js';
import { InvoicesResource } from './resources/Invoices.js';
import { SendsResource } from './resources/Sends.js';
import { SystemResource } from './resources/System.js';
import { WebhooksResource } from './resources/Webhooks.js';
import { WorkResource } from './resources/Work.js';
import { EventsResource } from './resources/Events.js';
import { SseConnection } from './sse-connection.js';

export interface RaiFlowClientOptions {
  /** Base URL of the RaiFlow runtime (e.g. "http://localhost:3000") */
  baseUrl: string;
  /** API key for authentication (sent as Bearer token) */
  apiKey: string;
  /** Base path for all API requests. Default: "/v1" */
  basePath?: string;
  /** Per-request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
}

export class RaiFlowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'RaiFlowApiError';
  }
}

export class RaiFlowClient {
  public accounts: AccountsResource;
  public blocks: BlocksResource;
  public invoiceAccounts: InvoiceAccountsResource;
  public invoices: InvoicesResource;
  public sends: SendsResource;
  public system: SystemResource;
  public webhooks: WebhooksResource;
  public work: WorkResource;
  public events: EventsResource;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly basePath: string;
  private readonly timeoutMs: number;
  private _sseConnection?: SseConnection;

  private constructor(options: RaiFlowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.basePath = options.basePath ?? '/v1';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.accounts = new AccountsResource(this);
    this.blocks = new BlocksResource(this);
    this.invoiceAccounts = new InvoiceAccountsResource(this);
    this.invoices = new InvoicesResource(this);
    this.sends = new SendsResource(this);
    this.system = new SystemResource(this);
    this.webhooks = new WebhooksResource(this);
    this.work = new WorkResource(this);
    this.events = new EventsResource(this);
  }

  public static initialize(options: RaiFlowClientOptions): RaiFlowClient {
    return new RaiFlowClient(options);
  }

  /** Internal: lazy-initialized SSE connection */
  get sseConnection(): SseConnection {
    if (!this._sseConnection) {
      this._sseConnection = new SseConnection(this.baseUrl, this.basePath, this.apiKey);
    }
    return this._sseConnection;
  }

  /** Internal: make an HTTP request to the runtime */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${this.basePath}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...headers,
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const payload = await res.json().catch(() => undefined) as { error?: { message?: string; code?: string } } | undefined;
      throw new RaiFlowApiError(
        payload?.error?.message ?? `RaiFlow API error ${res.status}`,
        res.status,
        payload?.error?.code ?? 'unknown_error',
        res.headers.get('x-request-id'),
      );
    }
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json();
    return data as T;
  }

  async requestRoot<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => undefined) as { error?: { message?: string; code?: string } } | undefined;
      throw new RaiFlowApiError(
        payload?.error?.message ?? `RaiFlow API error ${res.status}`,
        res.status,
        payload?.error?.code ?? 'unknown_error',
        res.headers.get('x-request-id'),
      );
    }
    return await res.json() as T;
  }

  async openStream(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${this.basePath}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string; code?: string } } | undefined;
      throw new RaiFlowApiError(
        payload?.error?.message ?? `RaiFlow API error ${response.status}`,
        response.status,
        payload?.error?.code ?? 'unknown_error',
        response.headers.get('x-request-id'),
      );
    }
    return response;
  }
}
