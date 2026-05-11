import type { AccountEvent } from '@openrai/model';

export class SseConnection {
  private streamId: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private readonly listeners = new Map<string, Set<(event: AccountEvent) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private connectPromise: Promise<string> | null = null;

  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async getStreamId(): Promise<string> {
    if (this.streamId) return this.streamId;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private async doConnect(): Promise<string> {
    const url = new URL(`${this.baseUrl}/api/accounts/stream`);
    this.abortController = new AbortController();

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      this.connectPromise = null;
      throw new Error(`SSE connection failed: ${res.status}`);
    }

    this.streamId = res.headers.get('x-raiflow-stream-id');
    if (!this.streamId) {
      this.connectPromise = null;
      throw new Error('SSE response missing X-Raiflow-Stream-Id header');
    }

    const body = res.body;
    if (body) {
      this.reader = body.getReader();
      void this.readLoop();
    }

    return this.streamId;
  }

  private async readLoop(): Promise<void> {
    if (!this.reader) return;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          this.processLine(line);
        }
      }
    } catch {
      // ignore
    } finally {
      this.reader.releaseLock();
      this.reader = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private processLine(line: string): void {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (!payload) return;
    try {
      const event = JSON.parse(payload) as AccountEvent;
      const set = this.listeners.get(event.accountAddress);
      if (set) {
        for (const listener of set) listener(event);
      }
    } catch {
      // ignore parse errors
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.streamId = null;
      this.connectPromise = null;
      if (!this.stopped) {
        void this.doConnect().catch(() => {});
      }
    }, delay);
  }

  watch(address: string): AsyncIterable<AccountEvent> {
    let set = this.listeners.get(address);
    if (!set) {
      set = new Set();
      this.listeners.set(address, set);
    }

    const queue: AccountEvent[] = [];
    const pending: ((result: IteratorResult<AccountEvent>) => void)[] = [];
    let closed = false;

    const listener = (event: AccountEvent) => {
      if (closed) return;
      if (pending.length > 0) {
        pending.shift()!({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    set.add(listener);
    const listeners = this.listeners;

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<AccountEvent>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as AccountEvent, done: true });
            }
            return new Promise((resolve) => pending.push(resolve));
          },
          return(): Promise<IteratorResult<AccountEvent>> {
            closed = true;
            set.delete(listener);
            if (set.size === 0) {
              listeners.delete(address);
            }
            while (pending.length > 0) {
              pending.shift()!({ value: undefined as unknown as AccountEvent, done: true });
            }
            return Promise.resolve({ value: undefined as unknown as AccountEvent, done: true });
          },
        };
      },
    };
  }

  unwatch(address: string): void {
    this.listeners.delete(address);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.reader?.releaseLock();
    this.reader = null;
  }
}
