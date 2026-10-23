import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readCursors(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveCursors(path, cursors) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cursors, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

/**
 * Poll RaiFlow's persisted global event sequence and commit the consumer cursor
 * only after each event handler succeeds. Replayed events must still be handled
 * idempotently if the process stops between handling and cursor persistence.
 */
export function startDurableEventConsumer({ client, cursorFile, consumerKey, onEvent, onError = console.error }) {
  let stopped = false;
  let running = false;

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const cursors = await readCursors(cursorFile);
      const entry = typeof cursors[consumerKey] === 'object' && cursors[consumerKey] !== null
        ? cursors[consumerKey]
        : { after: typeof cursors[consumerKey] === 'string' ? cursors[consumerKey] : undefined, events: [] };
      let after = typeof entry.after === 'string' ? entry.after : undefined;
      entry.events = Array.isArray(entry.events) ? entry.events : [];

      while (!stopped) {
        const page = await client.events.list({ ...(after ? { after } : {}), limit: 100 });
        if (page.data.length === 0) break;

        for (const event of page.data) {
          await onEvent(event);
          if (event.sequence !== undefined) {
            after = String(event.sequence);
            entry.after = after;
            entry.events.push(event);
            if (entry.events.length > 500) entry.events.splice(0, entry.events.length - 500);
            cursors[consumerKey] = entry;
            await saveCursors(cursorFile, cursors);
          }
        }

        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), 1_000);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async getRecentEvents() {
      const cursors = await readCursors(cursorFile);
      const entry = cursors[consumerKey];
      return typeof entry === 'object' && entry !== null && Array.isArray(entry.events)
        ? entry.events
        : [];
    },
  };
}

