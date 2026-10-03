import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { CommandLibrary } from "@ace/commands";
const threadId = ThreadId.max(128);
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("commands.runtime"), threadId, data: z.unknown() }),
  z.object({ type: z.literal("session.closed"), threadId }),
  z.object({
    type: z.literal("command.executed"),
    threadId,
    commandId: z.string().min(1).max(256),
  }),
]);
/** Trusted local engine events only. No socket client can emit execution receipts. */
export interface CommandEventSource {
  subscribe(handler: (event: unknown) => Promise<void>): () => void;
}
export function connectDaemonCommandEvents(
  library: CommandLibrary,
  source: CommandEventSource,
): () => void {
  let closed = false;
  const sessions = new Map<string, { active: boolean; pending: number }>();
  const stop = source.subscribe(async (raw) => {
    if (closed) return;
    const event = eventSchema.parse(raw);
    if (event.type === "session.closed") {
      library.clearRuntime(event.threadId);
      sessions.delete(event.threadId);
      return;
    }
    if (event.type === "command.executed") {
      await library.recordUse(event.threadId, event.commandId);
      return;
    }
    let session = sessions.get(event.threadId);
    if (!session) {
      if (sessions.size >= 1024) throw new Error("Command event session limit");
      session = { active: false, pending: 0 };
      sessions.set(event.threadId, session);
    }
    session.pending++;
    try {
      const accepted = await library.updateRuntime(event.threadId, event.data);
      if (accepted && sessions.get(event.threadId) === session && !closed) session.active = true;
    } finally {
      session.pending--;
      if (!session.active && !session.pending && sessions.get(event.threadId) === session)
        sessions.delete(event.threadId);
    }
  });
  return () => {
    if (closed) return;
    closed = true;
    try {
      stop();
    } finally {
      for (const thread of sessions.keys()) library.clearRuntime(thread);
      sessions.clear();
    }
  };
}
