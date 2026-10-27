import type { ThreadSource } from "@ace/client";
import { z } from "zod";
import { followAgents, type AgentsFollow, type PatchSink, type Preview } from "./agents.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
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
  #changes: ChangesSession | undefined;
  constructor(sink: PatchSink, preview: Preview) {
    this.#sink = sink;
    this.#preview = preview;
  }
  /** Thread navigation: nothing follows the previous thread. */
  close(): void {
    this.#agents?.stop();
    this.#agents = undefined;
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

function releases(action: z.infer<typeof SheetAction>): boolean {
  if (action.kind === "agents" || action.kind === "changes") return !action.open;
  return action.kind === "changes.file" && action.path === null;
}
