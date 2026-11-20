import type { ClientApi, ReadPriority } from "@ace/client";
import type { CheckoutSource, FileContent } from "./checkout-source.ts";

/*
 * Reads of checkout files started before they open (the pointer resting on an explorer row),
 * taken once by the open that follows, so the editor shows the file without waiting on a second
 * read. A read nobody takes is dropped after a short while: an older copy than that would be
 * read again anyway.
 */

/** How long a read-ahead waits to be taken. */
export const readAheadMs = 10_000;

interface Ahead {
  read: Promise<FileContent>;
  timer: ReturnType<typeof setTimeout>;
  /** Moves the rest of the read up to "visible": an open took it. */
  promote: () => void;
}

const byClient = new WeakMap<ClientApi, Map<string, Ahead>>();
const keyOf = (threadId: string, path: string) => `${threadId}\u0000${path}`;

function aheadOf(client: ClientApi): Map<string, Ahead> {
  let ahead = byClient.get(client);
  if (!ahead) {
    ahead = new Map();
    byClient.set(client, ahead);
  }
  return ahead;
}

/** Start reading `path` for the open that may follow; a read already waiting is kept. */
export function readAhead(
  client: ClientApi,
  source: CheckoutSource,
  threadId: string,
  path: string,
): void {
  const ahead = aheadOf(client);
  const key = keyOf(threadId, path);
  if (ahead.has(key)) return;
  // A prefetch waits behind every read on screen until an open takes it.
  let priority: ReadPriority = "background";
  const read = source.read(threadId, path, undefined, () => priority);
  const forget = () => {
    const entry = ahead.get(key);
    if (entry?.read !== read) return;
    clearTimeout(entry.timer);
    ahead.delete(key);
  };
  // A failed read-ahead is no answer: the open reads again and reports its own error.
  read.catch(forget);
  ahead.set(key, {
    read,
    timer: setTimeout(forget, readAheadMs),
    promote: () => {
      priority = "visible";
    },
  });
}

/** The read started ahead for `path`, once; undefined when none is waiting. */
export function takeReadAhead(
  client: ClientApi,
  threadId: string,
  path: string,
): Promise<FileContent> | undefined {
  const ahead = byClient.get(client);
  const key = keyOf(threadId, path);
  const entry = ahead?.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  // Someone opened it: what is left of the read now goes ahead of other prefetches.
  entry.promote();
  ahead?.delete(key);
  return entry.read;
}
