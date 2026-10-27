import type { ThreadSource } from "@ace/client";
import { z } from "zod";
import { followAgents, type PatchSink, type Preview } from "./agents.ts";
import { ChangesAction, changesAction } from "./changes-actions.ts";
import type { ChangesKept } from "./changes-kept.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
import { cancelDraft, DraftFor, writeDraft } from "./git-drafts.ts";

/*
 * The thread's Agents and Changes sheets. Each follows the open thread only while its sheet is
 * shown, so a closed sheet costs nothing and navigation releases both.
 */

const OpenAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agents"), open: z.boolean() }),
  z.object({ kind: z.literal("changes"), open: z.boolean() }),
  z.object({ kind: z.literal("changes.refresh") }),
  z.object({ kind: z.literal("changes.file"), path: z.string().min(1).max(4096).nullable() }),
  z.object({ kind: z.literal("git"), action: z.unknown(), requestId: z.string().min(1).max(64) }),
  /** An AI draft of the commit message or PR title and summary (`git-drafts.ts`). */
  z.object({ kind: z.literal("git.draft"), for: DraftFor, requestId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("git.draft.cancel"), requestId: z.string().min(1).max(64) }),
]);
const SheetAction = z.union([OpenAction, ChangesAction]);
type SheetAction = z.infer<typeof SheetAction>;

/** What every Changes session shares: the phone's kept review state and a clock. */
export interface SheetDeps {
  kept?: ChangesKept;
  now?: () => number;
}

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
  #deps: SheetDeps;
  constructor(sink: PatchSink, preview: Preview, deps: SheetDeps = {}) {
    this.#sink = sink;
    this.#preview = preview;
    this.#deps = deps;
  }
  /** Thread navigation: nothing follows the previous thread. */
  close(): void {
    this.#agents?.();
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
              this.#deps,
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
      default:
        return this.#changes
          ? changesAction(this.#changes, action, this.#sink, this.#preview)
          : false;
    }
  }
}

function releases(action: SheetAction): boolean {
  if (action.kind === "agents" || action.kind === "changes") return !action.open;
  if (action.kind === "changes.open" || action.kind === "changes.expand") return !action.open;
  return action.kind === "changes.file" && action.path === null;
}
