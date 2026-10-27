import type { ThreadSource } from "@ace/client";
import { z } from "zod";
import { followAgents, type AgentsFollow, type PatchSink, type Preview } from "./agents.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
import { followLogs, LogsQuery, type LogsFollow } from "./logs.ts";
import { cancelDraft, DraftFor, writeDraft } from "./git-drafts.ts";

/*
 * The thread's Agents and Changes sheets. Each follows the open thread only while its sheet is
 * shown, so a closed sheet costs nothing and navigation releases both.
 */

const SheetAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agents"), open: z.boolean() }),
  /** The next page of the open Agents sheet's agents or background tasks. */
  z.object({ kind: z.literal("agents.more"), list: z.enum(["agents", "tasks"]) }),
  z.object({ kind: z.literal("changes"), open: z.boolean() }),
  /** The thread's Logs: opened or closed, or its scope and filter changed while open. */
  z.object({ kind: z.literal("logs"), open: z.boolean(), query: LogsQuery.optional() }),
  z.object({ kind: z.literal("logs.earlier") }),
  /** The shown lines as text for Copy, answered under `logs.copy`. */
  z.object({ kind: z.literal("logs.copy"), requestId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("changes.refresh") }),
  z.object({ kind: z.literal("changes.file"), path: z.string().min(1).max(4096).nullable() }),
  z.object({ kind: z.literal("git"), action: z.unknown(), requestId: z.string().min(1).max(64) }),
  /** An AI draft of the commit message or PR title and summary (`git-drafts.ts`). */
  z.object({ kind: z.literal("git.draft"), for: DraftFor, requestId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("git.draft.cancel"), requestId: z.string().min(1).max(64) }),
]);

export interface OpenThread {
  owner: ChangesOwner;
  store: ThreadSource;
  threadId: string;
  epoch: number;
}

export class Sheets {
  #sink: PatchSink;
  #preview: Preview;
  #agents: AgentsFollow | undefined;
  #logs: LogsFollow | undefined;
  #changes: ChangesSession | undefined;
  constructor(sink: PatchSink, preview: Preview) {
    this.#sink = sink;
    this.#preview = preview;
  }
  /** Thread navigation: nothing follows the previous thread. */
  close(): void {
    this.#agents?.stop();
    this.#agents = undefined;
    this.#logs?.stop();
    this.#logs = undefined;
    this.#changes?.close();
    this.#changes = undefined;
  }
  /**
   * False when the action can't be read or no thread is open. A sheet's close arriving after
   * its thread was left has nothing left to release, so it succeeds.
   */
  action(thread: OpenThread | undefined, raw: unknown): boolean {
    const parsed = SheetAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    if (!thread) return releases(action);
    switch (action.kind) {
      case "agents":
        this.#agents?.stop();
        this.#agents = action.open
          ? followAgents(thread.store, thread.threadId, thread.epoch, this.#sink, this.#preview)
          : undefined;
        return true;
      case "agents.more":
        this.#agents?.more(action.list);
        return this.#agents !== undefined;
      case "logs": {
        const query = action.query ?? LogsQuery.parse({});
        if (!action.open) {
          this.#logs?.stop();
          this.#logs = undefined;
          this.#sink.clear("logs.copy:");
        } else if (this.#logs) this.#logs.query(query);
        else
          this.#logs = followLogs(
            thread.store,
            thread.threadId,
            thread.epoch,
            this.#sink,
            this.#preview,
            logTime,
            query,
          );
        return true;
      }
      case "logs.earlier":
        this.#logs?.earlier();
        return this.#logs !== undefined;
      case "logs.copy": {
        const logs = this.#logs;
        if (!logs) return false;
        const id = action.requestId;
        // At most one Copy answer is kept: an earlier one is dropped, and closing Logs drops it.
        // It stays readable until then, so a redelivered frame still carries the text.
        this.#sink.clear("logs.copy:");
        this.#sink.put(`logs.copy:${id}`, () => ({ type: "logs.copy", id, text: logs.copy() }));
        return true;
      }
      case "changes":
        this.#changes?.close();
        this.#changes = action.open
          ? new ChangesSession(
              thread.owner,
              thread.store,
              thread.threadId,
              thread.epoch,
              this.#sink,
              this.#preview,
            )
          : undefined;
        return true;
      case "changes.refresh":
        void this.#changes?.refresh();
        return this.#changes !== undefined;
      case "changes.file":
        this.#changes?.file(action.path ?? undefined);
        return this.#changes !== undefined;
      case "git": {
        const session = this.#changes;
        if (!session) return false;
        void gitAction(
          thread.owner,
          session,
          action.action,
          action.requestId,
          this.#sink,
          this.#preview,
        );
        return true;
      }
      case "git.draft": {
        const session = this.#changes;
        if (!session) return false;
        void writeDraft(
          thread.owner,
          session,
          action.for,
          action.requestId,
          this.#sink,
          this.#preview,
        );
        return true;
      }
      case "git.draft.cancel":
        if (this.#changes) cancelDraft(this.#changes, action.requestId);
        return this.#changes !== undefined;
    }
  }
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const logTime = (at: number) => clock.format(at);

function releases(action: z.infer<typeof SheetAction>): boolean {
  if (action.kind === "agents" || action.kind === "changes" || action.kind === "logs")
    return !action.open;
  return action.kind === "changes.file" && action.path === null;
}
