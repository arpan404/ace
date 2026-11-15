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
  /** Stop following `threadId` if it lingers after the person left it (ADR 0146). */
  letGo?(threadId: string): void;
  /** Drop persisted tool logs when forcing a fresh read of this thread. */
  forgetSteps?(threadId: string): Promise<void>;
}

export async function handleCacheAction(action: CacheAction, host: ChatCacheHost): Promise<void> {
  let problem: string | undefined;
  try {
    switch (action.type) {
      case "cache.read":
        break;
      case "cache.clear":
        await host.client.clearReadSnapshots();
        break;
      case "cache.reload": {
        // A lingering hold would keep the old copy; the reload reads it afresh.
        host.letGo?.(action.threadId);
        const open = host.openThread() === action.threadId;
        if (open) host.leave();
        try {
          await host.client.forgetThread(action.threadId);
          await host.forgetSteps?.(action.threadId);
        } finally {
          if (open) host.reopen(action.threadId);
        }
        break;
      }
    }
  } catch {
    problem =
      action.type === "cache.clear" ? "Couldn't clear cached chats." : "Couldn't reload this chat.";
  }
  await publishUsage(host, action, problem);
}

async function publishUsage(
  host: ChatCacheHost,
  action: CacheAction,
  problem?: string,
): Promise<void> {
  let usage: { threads: number; bytes: number } = { threads: 0, bytes: 0 };
  let measured = false;
  try {
    usage = await host.snapshots.usage();
    measured = true;
  } catch {
    problem ??= "Couldn't read cached chats.";
  }
  const retry = problem ? action.type : undefined;
  host.sink.put("cache.usage", () => ({
    type: "cache.usage",
    ...usage,
    measured,
    problem,
    retry,
    ...(action.type === "cache.reload" ? { threadId: action.threadId } : {}),
  }));
}
