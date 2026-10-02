import { setTimeout as delay } from "node:timers/promises";
import { SseParser, type SseEvent } from "./sse-parser.ts";
export type { SseEvent } from "./sse-parser.ts";

export type SseOptions = {
  signal: AbortSignal;
  headers?: ConstructorParameters<typeof Headers>[0];
  onEvent: (event: SseEvent) => void;
  /** Defaults to reconnecting. false preserves one-shot stream consumption. */
  reconnect?: false | { initialDelayMs?: number; maxDelayMs?: number };
  onReconnect?: (info: { attempt: number; delayMs: number; error?: Error }) => void;
  heartbeat?: {
    gapMs: number;
    /** Defaults to treating every dispatched event as a heartbeat. */
    isHeartbeat?: (event: SseEvent) => boolean;
    onGap: (elapsedMs: number) => void;
  };
};

function positive(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0))
    throw new RangeError(`Invalid ${name}`);
  return value;
}

/** Fetch SSE until cancelled. Resumes reconnects with Last-Event-ID when supplied. */
export async function readSse(url: string | URL, options: SseOptions): Promise<void> {
  const { signal, heartbeat } = options;
  const reconnect = options.reconnect === false ? false : (options.reconnect ?? {});
  const initial = positive(
    reconnect === false ? 500 : (reconnect.initialDelayMs ?? 500),
    "initialDelayMs",
    true,
  );
  const maximum = positive(
    reconnect === false ? 30_000 : (reconnect.maxDelayMs ?? 30_000),
    "maxDelayMs",
    true,
  );
  if (heartbeat) positive(heartbeat.gapMs, "gapMs");
  let lastEventId = "";
  let retryMs = initial;
  let attempt = 0;
  let failures = 0;
  while (!signal.aborted) {
    let failure: Error | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let lastHeartbeat = performance.now();
    const armHeartbeat = () => {
      if (!heartbeat) return;
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (signal.aborted) return;
        heartbeat.onGap(performance.now() - lastHeartbeat);
        armHeartbeat();
      }, heartbeat.gapMs);
    };
    const parser = new SseParser((event) => {
      failures = 0;
      if (heartbeat && (!heartbeat.isHeartbeat || heartbeat.isHeartbeat(event))) {
        lastHeartbeat = performance.now();
        armHeartbeat();
      }
      options.onEvent(event);
    }, lastEventId);
    let body: ReadableStream<Uint8Array> | null = null;
    try {
      armHeartbeat();
      const headers = new Headers(options.headers);
      headers.set("accept", "text/event-stream");
      if (lastEventId) headers.set("last-event-id", lastEventId);
      const response = await fetch(url, { headers, signal });
      body = response.body;
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`SSE HTTP status ${response.status}`);
      if (!body) throw new Error("SSE response has no body");
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        throw new Error("Expected text/event-stream response");
      }
      const decoder = new TextDecoder();
      for await (const chunk of body) {
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
      parser.feed(decoder.decode());
      // Incomplete final events are deliberately discarded, as in EventSource.
      if (reconnect === false) return;
    } catch (error) {
      if (signal.aborted) return;
      failure = error instanceof Error ? error : new Error(String(error));
      if (reconnect === false) throw failure;
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (body && !body.locked) await body.cancel().catch(() => {});
    }
    lastEventId = parser.lastEventId;
    retryMs = parser.retryMs ?? retryMs;
    if (signal.aborted) return;
    const delayMs = Math.min(maximum, retryMs * 2 ** Math.min(failures++, 30));
    options.onReconnect?.({ attempt: ++attempt, delayMs, ...(failure ? { error: failure } : {}) });
    try {
      await delay(delayMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
