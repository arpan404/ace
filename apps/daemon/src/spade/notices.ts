import type { Notification, ThreadId } from "@ace/protocol";
import type { LiveEnd, SpadeConnection } from "./forward.ts";
import type { SpadeReady } from "./link.ts";
import { alertFromSpadeNotice } from "./notice-alert.ts";

/** The longest a notice may be. Spade's are a sentence and a few ids. */
const maxNoticeChars = 16_384;
const firstRetryMs = 1000;
const lastRetryMs = 30_000;

export interface SpadeNoticeOptions {
  /** The Spade instance answering now, if any. */
  ready(): SpadeReady | undefined;
  /** Called with each Spade instance as it is first seen ready; returns a stop. */
  onReady(listener: (ready: SpadeReady) => void): () => void;
  /** Spade's host thread, which the alerts are filed under; none while Spade has no grant. */
  hostThread(): ThreadId | undefined;
  /** ace's notification worker: delivery to every device, once per id. */
  notify(notification: Notification): Promise<void>;
  /** `spadeLive` from `@ace/service/spade`. */
  live(
    connection: SpadeConnection,
    path: string,
    options: { signal: AbortSignal; maxEventChars: number; onEvent(event: { event: string; data: string }): void },
  ): Promise<LiveEnd>;
  after(ms: number, run: () => void): () => void;
  report(error: unknown): void;
}

/**
 * Follows Spade's notice stream (`GET /v1/notices/live`, ADR 0165) for as long as Spade runs,
 * and hands each notice Spade sends to reach the person now (ADR 0194) to ace's notification
 * worker, which delivers it to every desktop and web device once. One stream per daemon, so a
 * notice is one alert however many windows are open. The stream sends what happens while it is
 * open: a gap while Spade restarts is covered by Spade's summary and its brief, not replayed.
 */
export function followSpadeNotices(options: SpadeNoticeOptions): { close(): void } {
  let closed = false;
  let open: { generation: number; controller: AbortController } | undefined;
  let cancelRetry: (() => void) | undefined;
  let wait = firstRetryMs;

  const onEvent = (event: { event: string; data: string }) => {
    if (event.event !== "notice") return;
    const thread = options.hostThread();
    if (!thread) return;
    const alert = alertFromSpadeNotice(event.data, thread);
    if (alert) void options.notify(alert).catch(options.report);
  };
  const connect = (ready: SpadeReady) => {
    if (closed || open?.generation === ready.generation) return;
    open?.controller.abort();
    cancelRetry?.();
    const stream = { generation: ready.generation, controller: new AbortController() };
    open = stream;
    void options
      .live(ready.connection, "/v1/notices/live", {
        signal: stream.controller.signal,
        maxEventChars: maxNoticeChars,
        onEvent(event) {
          wait = firstRetryMs;
          onEvent(event);
        },
      })
      .catch(options.report)
      .then(() => {
        if (open !== stream) return;
        open = undefined;
        if (closed) return;
        // The same Spade closed it (a restart under way, a slow reader): look again soon.
        cancelRetry = options.after(wait, () => {
          cancelRetry = undefined;
          const now = options.ready();
          if (now) connect(now);
        });
        wait = Math.min(wait * 2, lastRetryMs);
      });
  };
  const stopReady = options.onReady((ready) => {
    wait = firstRetryMs;
    connect(ready);
  });
  const now = options.ready();
  if (now) connect(now);
  return {
    close() {
      closed = true;
      stopReady();
      cancelRetry?.();
      open?.controller.abort();
      open = undefined;
    },
  };
}
