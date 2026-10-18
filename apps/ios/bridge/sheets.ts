import type { ThreadSource } from "@ace/client";
import { z } from "zod";
import { followAgents, type PatchSink, type Preview } from "./agents.ts";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";

/*
 * The thread's Agents and Changes sheets. Each follows the open thread only while its sheet is
 * shown, so a closed sheet costs nothing and navigation releases both.
 */

const SheetAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agents"), open: z.boolean() }),
  z.object({ kind: z.literal("changes"), open: z.boolean() }),
  z.object({ kind: z.literal("changes.refresh") }),
  z.object({ kind: z.literal("changes.file"), path: z.string().min(1).max(4096).nullable() }),
  z.object({ kind: z.literal("git"), action: z.unknown(), requestId: z.string().min(1).max(64) }),
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
  }
  /** False when the action can't be read or no thread is open. */
  action(thread: OpenThread | undefined, raw: unknown): boolean {
    const parsed = SheetAction.safeParse(raw);
    if (!parsed.success || !thread) return false;
    const action = parsed.data;
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
    }
  }
}
