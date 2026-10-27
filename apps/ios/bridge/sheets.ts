import type { ThreadSource } from "@ace/client";
import { z } from "zod";
import { followAgents, type PatchSink, type Preview } from "./agents.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
import { cancelDraft, DraftFor, writeDraft } from "./git-drafts.ts";
import { WorkSession } from "./work.ts";
import { clearStaleLock, workAction } from "./work-actions.ts";

/*
 * The thread's Agents, Changes and Work sheets. Each follows the open thread only while its sheet
 * is shown, so a closed sheet costs nothing and navigation releases them all. Clearing a stale
 * Git lock needs no sheet: the transcript offers it where a message was stopped.
 */

const SheetAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agents"), open: z.boolean() }),
  z.object({ kind: z.literal("changes"), open: z.boolean() }),
  z.object({ kind: z.literal("changes.refresh") }),
  z.object({ kind: z.literal("changes.file"), path: z.string().min(1).max(4096).nullable() }),
  z.object({ kind: z.literal("git"), action: z.unknown(), requestId: z.string().min(1).max(64) }),
  /** An AI draft of the commit message or PR title and summary (`git-drafts.ts`). */
  z.object({ kind: z.literal("git.draft"), for: DraftFor, requestId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("git.draft.cancel"), requestId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("work"), open: z.boolean() }),
  z.object({ kind: z.literal("work.refresh") }),
  z.object({ kind: z.literal("work.branches") }),
  z.object({
    kind: z.literal("work.action"),
    action: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  z.object({ kind: z.literal("lock.clear"), requestId: z.string().min(1).max(64) }),
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
  #agents: (() => void) | undefined;
  #changes: ChangesSession | undefined;
  #work: WorkSession | undefined;
  constructor(sink: PatchSink, preview: Preview) {
    this.#sink = sink;
    this.#preview = preview;
  }
  /** Thread navigation: nothing follows the previous thread. */
  close(): void {
    this.#agents?.();
    this.#agents = undefined;
    this.#changes?.close();
    this.#changes = undefined;
    this.#work?.close();
    this.#work = undefined;
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
        this.#agents?.();
        this.#agents = action.open
          ? followAgents(thread.store, thread.threadId, thread.epoch, this.#sink, this.#preview)
          : undefined;
        return true;
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
      case "work":
        this.#work?.close();
        this.#work = action.open
          ? new WorkSession(
              thread.owner,
              thread.store,
              thread.threadId,
              thread.epoch,
              this.#sink,
              this.#preview,
            )
          : undefined;
        return true;
      case "work.refresh":
        void this.#work?.read();
        return this.#work !== undefined;
      case "work.branches":
        void this.#work?.branches();
        return this.#work !== undefined;
      case "work.action": {
        const session = this.#work;
        if (!session) return false;
        void workAction(session, action.action, action.requestId, this.#sink, this.#preview);
        return true;
      }
      case "lock.clear":
        void clearStaleLock(
          thread.owner,
          thread.threadId,
          action.requestId,
          this.#sink,
          this.#preview,
        );
        return true;
    }
  }
}

function releases(action: z.infer<typeof SheetAction>): boolean {
  if (action.kind === "agents" || action.kind === "changes" || action.kind === "work")
    return !action.open;
  return action.kind === "changes.file" && action.path === null;
}
