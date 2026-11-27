// SPDX-License-Identifier: Apache-2.0
/**
 * The queue's shell half (E5.4a): `queue`, `queuePage` and the attachment-retention read, over
 * the binding's JSON. The page's refusals are plain `Error`s, as `queuePage` throws them.
 */
import type { QueueGet, QueuePage, QueueSnapshot, ThreadId } from "@ace/protocol";
import type { NativeEngineHandle } from "./contracts.ts";
import { incomplete } from "./contracts.ts";

function member(binding: NativeEngineHandle, name: string): (...args: unknown[]) => unknown {
  const value = binding[name];
  if (typeof value !== "function") throw incomplete(name, "E5.4a");
  return value.bind(binding) as (...args: unknown[]) => unknown;
}

/** `queue(id)`: the thread's snapshot, or the defaults when it never queued. */
export function queueSnapshot(binding: NativeEngineHandle, id: ThreadId): QueueSnapshot {
  return JSON.parse(member(binding, "queue")(id) as string) as QueueSnapshot;
}

/** `queuePage(request)`: the versioned cursor page. */
export function queuePage(
  binding: NativeEngineHandle,
  request: Pick<QueueGet, "threadId" | "after" | "expectedRevision" | "limit">,
): QueuePage {
  return JSON.parse(member(binding, "queuePage")(JSON.stringify(request)) as string) as QueuePage;
}

/** Whether a live intent still retains the attachment, including the fallback. */
export function queueRetains(binding: NativeEngineHandle, id: ThreadId, hash: string): boolean {
  return member(binding, "queueRetains")(id, hash) as boolean;
}
