import { randomUUID } from 'node:crypto';
import type { WebhookOutboxStore } from '@openrai/storage';
import { attemptWebhookDelivery } from '@openrai/webhook';

const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 60_000;

export class WebhookOutboxWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing = false;
  private readonly workerId = randomUUID();

  constructor(
    private readonly store: WebhookOutboxStore,
    private readonly options: {
      intervalMs?: number;
      concurrency?: number;
      timeoutMs?: number;
      maxAttempts?: number;
    } = {},
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs ?? 1_000);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  wake(): void {
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = new Date();
      const claimed = await this.store.claimReady(
        this.workerId,
        now.toISOString(),
        new Date(now.getTime() + 30_000).toISOString(),
        this.options.concurrency ?? 4,
      );
      await Promise.allSettled(claimed.map((delivery) => this.deliver(delivery)));
    } catch {
      // The persisted lease expires and another poll or process can recover it.
    } finally {
      this.processing = false;
    }
  }

  private async deliver(delivery: Awaited<ReturnType<WebhookOutboxStore['claimReady']>>[number]): Promise<void> {
    const number = delivery.attemptCount + 1;
    const attemptedAt = new Date();
    const result = await attemptWebhookDelivery(
      delivery.endpoint,
      delivery.event,
      this.options.timeoutMs ?? 10_000,
    );
    const maxAttempts = this.options.maxAttempts ?? MAX_ATTEMPTS;
    const terminal = result.status === 'terminal'
      || (result.status === 'retry' && number >= maxAttempts);
    const retryAt = result.status === 'retry' && !terminal
      ? new Date(attemptedAt.getTime() + this.retryDelay(number)).toISOString()
      : null;
    await this.store.recordAttempt(delivery.id, this.workerId, {
      number,
      status: result.status === 'delivered' ? 'delivered' : terminal ? 'failed' : 'retry',
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      error: result.error,
      nextRetryAt: retryAt,
      attemptedAt: attemptedAt.toISOString(),
    });
  }

  private retryDelay(attempt: number): number {
    const base = Math.min(1_000 * (2 ** Math.max(0, attempt - 1)), MAX_BACKOFF_MS);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }
}
