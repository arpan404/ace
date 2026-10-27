import type { ClientCore, RowSnapshots } from "@ace/client";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * The chats this phone keeps for one machine (ADR 0105), as Settings shows and clears them:
 * how many threads and how many bytes on disk, clearing them all, and reloading one thread from
 * the machine. Only cached reads go: the outbox, unsent drafts and kept settings stay.
 */

export const CacheAction = z.discriminatedUnion("type", [
  /** Answer `cache.usage`. */
  z.object({ type: z.literal("cache.read") }),
  /** Drop every cached chat of this machine, then answer `cache.usage`. */
  z.object({ type: z.literal("cache.clear") }),
  /** Drop one thread's cached copy; an open one is read again from the machine. */
  z.object({ type: z.literal("cache.reload"), threadId: z.string().min(1).max(256) }),
]);
export type CacheAction = z.infer<typeof CacheAction>;

export interface ChatCacheHost {
  client: Pick<ClientCore, "forgetThread" | "clearReadSnapshots">;
  snapshots: Pick<RowSnapshots, "usage">;
  sink: PatchSink;
  /** The thread open on the phone, if any. */
  openThread(): string | undefined;
  /** Leave the open thread without telling native: it is reopened at once. */
  leave(): void;
  /** Open `threadId` cold, as native asked by `cache.reload`. */
  reopen(threadId: string): void;
}

export function handleCacheAction(action: CacheAction, host: ChatCacheHost): Promise<void> {
  switch (action.type) {
    case "cache.read":
      return publishUsage(host);
    case "cache.clear":
      return host.client
        .clearReadSnapshots()
        .catch(() => {})
        .then(() => publishUsage(host));
    case "cache.reload": {
      const open = host.openThread() === action.threadId;
      // The lease goes first so the store can be let go; the drop is asked before the reopen's
      // read, so that read is a miss and the thread comes from the machine.
      if (open) host.leave();
      const forgotten = host.client.forgetThread(action.threadId).catch(() => {});
      if (open) host.reopen(action.threadId);
      return forgotten.then(() => publishUsage(host));
    }
  }
}

async function publishUsage(host: ChatCacheHost): Promise<void> {
  let usage: { threads: number; bytes: number };
  try {
    usage = await host.snapshots.usage();
  } catch {
    return;
  }
  host.sink.put("cache.usage", () => ({ type: "cache.usage", ...usage }));
}
