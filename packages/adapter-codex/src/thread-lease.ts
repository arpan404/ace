import { openAppServer, type AppServerOptions } from "./app-server.ts";

/**
 * Codex keeps an unsubscribed thread loaded, and its writer lock held, for 30 minutes by default.
 * ace resumes a thread from disk whenever it opens it again, so its app-servers unload a thread as
 * soon as the last subscriber leaves. That lets another process (an account switch, the user's own
 * terminal) take the thread once ace has closed it.
 */
export const unloadClosedThreads = ["-c", "thread_unload_delay_secs=0"] as const;

export type CodexThreadLease =
  | { held: true; release(): Promise<void> }
  | { held: false; reason: string };

export type ThreadLeaseOptions = AppServerOptions & {
  threadId: string;
  /** Codex unloads a just-closed thread a moment after its last subscriber leaves. */
  attempts?: number;
  /** Waits between attempts; injected so tests don't sleep. */
  wait?: (ms: number) => Promise<void>;
};

const busy = /already has an active writer/i;

/**
 * Hold one Codex thread's writer lock through the CLI that owns it. A short-lived app-server
 * resumes the thread (no model turn, no quota), which takes Codex's own per-thread lock: while it
 * is held, no other Codex process can write the thread. When another process holds it, the lease
 * reports that instead of throwing. Releasing unsubscribes, which unloads the thread, then stops
 * the process.
 */
export async function holdCodexThread(options: ThreadLeaseOptions): Promise<CodexThreadLease> {
  const server = await openAppServer({ ...options, args: [...unloadClosedThreads] }, "codex-lease");
  const attempts = Math.max(1, options.attempts ?? 10);
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await wait(300);
      try {
        await server.rpc.request(
          "thread/resume",
          { threadId: options.threadId, excludeTurns: true },
          { signal: options.signal },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!busy.test(message)) throw error;
        continue;
      }
      return {
        held: true,
        // Stopping the process releases the lock even if unsubscribing failed.
        release: async () => {
          await server.rpc
            .request(
              "thread/unsubscribe",
              { threadId: options.threadId },
              { signal: options.signal },
            )
            .catch(() => {});
          await server.close();
        },
      };
    }
  } catch (error) {
    await server.close();
    throw error;
  }
  await server.close();
  return { held: false, reason: "Another Codex process has this conversation open" };
}
