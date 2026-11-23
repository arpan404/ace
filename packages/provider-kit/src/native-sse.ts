// SPDX-License-Identifier: Apache-2.0
/** The SSE parser's native half: one `feed` per chunk, events dispatched here. */

import { streams } from "./native-stream-addon.ts";

/**
 * The parser behind `SseParser`: one crossing per chunk, the events dispatched in
 * order with the retry interval in force at each dispatch, and the limits' errors
 * thrown through the caller's factory.
 */
export class NativeSseParser {
  lastEventId: string;
  retryMs: number | undefined;
  readonly #handle: {
    feed(text: string): {
      events: { data: string; event: string; id: string; retryMs?: number | null }[];
      error?: string | null;
    };
    lastEventId(): string;
    retryMs(): number | null | undefined;
  };
  readonly #emit: (event: { data: string; event: string; id: string }) => void;
  readonly #limitError: (message: string) => Error;

  constructor(
    emit: (event: { data: string; event: string; id: string }) => void,
    lastEventId: string,
    maxLineBytes: number,
    maxEventBytes: number,
    limitError: (message: string) => Error,
  ) {
    this.#handle = new (streams().SseParserNative)(maxLineBytes, maxEventBytes, lastEventId);
    this.#emit = emit;
    this.#limitError = limitError;
    this.lastEventId = lastEventId;
    this.retryMs = undefined;
  }

  feed(text: string): void {
    const outcome = this.#handle.feed(text);
    for (const event of outcome.events) {
      // A `retry:` line before the event is visible to its listener, and the
      // dispatched id is already the last one, as the TypeScript set them.
      this.retryMs = event.retryMs ?? undefined;
      this.lastEventId = event.id;
      this.#emit({ data: event.data, event: event.event, id: event.id });
    }
    this.lastEventId = this.#handle.lastEventId();
    this.retryMs = this.#handle.retryMs() ?? undefined;
    if (outcome.error != null) throw this.#limitError(outcome.error);
  }
}
