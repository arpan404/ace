import type { CommandPayload } from "@ace/protocol";
import type { Intent } from "./intents.ts";

export type SendPayload = Extract<CommandPayload, { type: "thread.send" | "thread.create" }>;
export interface PendingSend {
  commandId: string;
  itemId: string;
  threadId: string;
  payload: SendPayload;
  state: "saving" | "sent" | "accepted" | "delivered" | "failed";
  error?: string;
  /** Show "Still waiting for the daemon..." after five seconds without a receipt. */
  waiting: boolean;
}
export function pendingSend(intent: Intent): PendingSend | undefined {
  const payload = intent.command.payload;
  if (payload.type !== "thread.send" && payload.type !== "thread.create") return undefined;
  return {
    commandId: intent.command.id,
    itemId: `input:${intent.command.id}`,
    threadId: intent.threadId ?? payload.threadId ?? `pending:${intent.command.id}`,
    payload,
    state:
      intent.state === "failed"
        ? "failed"
        : intent.delivered
          ? "delivered"
          : intent.state === "acked"
            ? "accepted"
            : intent.state === "saving"
              ? "saving"
              : "sent",
    ...(intent.error === undefined ? {} : { error: intent.error }),
    waiting: intent.waiting === true && intent.state === "pending",
  };
}
export function pendingSendsEqual(a: readonly PendingSend[], b: readonly PendingSend[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const next = b[i];
      return (
        next !== undefined &&
        entry.commandId === next.commandId &&
        entry.state === next.state &&
        entry.threadId === next.threadId &&
        entry.error === next.error &&
        entry.waiting === next.waiting &&
        entry.payload === next.payload
      );
    })
  );
}
/** A create remains addressable by its provisional route after its receipt supplies a thread id. */
export function matchesPendingThread(entry: PendingSend, threadId?: string): boolean {
  return (
    threadId === undefined ||
    entry.threadId === threadId ||
    (entry.payload.type === "thread.create" && threadId === `pending:${entry.commandId}`)
  );
}
