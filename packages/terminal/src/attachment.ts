import type { ByteRing } from "./ring.ts";
import type { ExitStatus, TerminalAttachment, TerminalEvent } from "./types.ts";

export function createAttachment(
  ring: ByteRing,
  fromOffset: number,
  getExit: () => ExitStatus | null,
  subscribe: (wake: () => void) => () => void,
): TerminalAttachment {
  let cursor = Math.max(fromOffset, ring.start);
  let truncated = cursor !== fromOffset;
  let aligned = false;
  let done = false;
  let pending: ((result: IteratorResult<TerminalEvent>) => void) | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  const endResult: IteratorResult<TerminalEvent> = { done: true, value: undefined };

  function poll(): IteratorResult<TerminalEvent> | undefined {
    if (done) return endResult;
    if (cursor < ring.start) {
      finish();
      return {
        done: false,
        value: { type: "resync", oldestOffset: ring.start, nextOffset: ring.end },
      };
    }
    const exit = getExit();
    if (!aligned) {
      const start = ring.alignStart(cursor, exit !== null);
      if (start === undefined) return undefined;
      truncated ||= start !== cursor;
      cursor = start;
      aligned = true;
    }
    const limit = Math.min(ring.end, cursor + 64 * 1024);
    const end = exit && limit === ring.end ? limit : ring.completeEnd(cursor, limit);
    if (end > cursor) {
      const event: TerminalEvent = {
        type: "data",
        offset: cursor,
        endOffset: end,
        data: ring.read(cursor, end).toString("utf8"),
        truncatedBefore: truncated,
      };
      cursor = end;
      truncated = false;
      return { done: false, value: event };
    }
    if (exit && cursor === ring.end) {
      finish();
      return { done: false, value: { type: "exit", status: { ...exit }, nextOffset: ring.end } };
    }
    return undefined;
  }

  const unsubscribe = subscribe(() => {
    if (!pending) return;
    let result: IteratorResult<TerminalEvent> | undefined;
    try {
      result = poll();
    } catch (error) {
      finish();
      rejectPending?.(error);
      pending = undefined;
      rejectPending = undefined;
      return;
    }
    if (result) {
      const resolve = pending;
      pending = undefined;
      rejectPending = undefined;
      resolve(result);
    }
  });

  function finish(): void {
    done = true;
    unsubscribe();
  }

  function detach(): void {
    finish();
    pending?.(endResult);
    pending = undefined;
    rejectPending = undefined;
  }

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (pending)
        return Promise.reject(new Error("Only one next() may be pending per attachment"));
      let result: IteratorResult<TerminalEvent> | undefined;
      try {
        result = poll();
      } catch (error) {
        finish();
        return Promise.reject(error);
      }
      return result
        ? Promise.resolve(result)
        : new Promise((resolve, reject) => {
            pending = resolve;
            rejectPending = reject;
          });
    },
    return() {
      detach();
      return Promise.resolve(endResult);
    },
    detach,
  };
}
