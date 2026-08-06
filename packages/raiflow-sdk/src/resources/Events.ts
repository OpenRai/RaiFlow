import type { EventQueryOptions, PaginatedEventsResponse, RaiFlowEvent } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export class EventsResource {
  constructor(private readonly client: RaiFlowClient) {}

  async list(options: EventQueryOptions = {}): Promise<PaginatedEventsResponse> {
    const params = new URLSearchParams();
    if (options.after) params.set('after', options.after);
    if (options.type) params.set('type', options.type);
    if (options.resourceType) params.set('resourceType', options.resourceType);
    if (options.resourceId) params.set('resourceId', options.resourceId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.client.request<PaginatedEventsResponse>('GET', `/events${query ? `?${query}` : ''}`);
  }

  async *stream(options: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<RaiFlowEvent> {
    const query = options.after ? `?after=${encodeURIComponent(options.after)}` : '';
    const response = await this.client.openStream(`/events/stream${query}`, options.signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Event stream response has no body');
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) yield JSON.parse(data.slice(6)) as RaiFlowEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
