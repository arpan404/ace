import { z } from "zod";
import type { GitService } from "@ace/git";
import type { ThreadDetails, ThreadId } from "@ace/protocol";
import { OutputLog } from "./creation-output.ts";
import { runSetupScript } from "./creation-setup.ts";
import type { Store } from "./store.ts";

type WorktreeSetup = NonNullable<ThreadDetails["worktreeSetup"]>;
const Choice = z.enum(["retry", "continue"]);

/**
 * The setup script of a worktree made when its thread first runs, as for one a person starts:
 * one script, run only when the thread's access would allow commands. A failure keeps the
 * worktree and the thread's queue held until the person chooses Retry or Continue.
 */
export class LateSetup {
  private store: Store;
  private git: Pick<GitService, "setupWorktree">;
  private now: () => number;
  constructor(store: Store, git: Pick<GitService, "setupWorktree">, now: () => number) {
    this.store = store;
    this.git = git;
    this.now = now;
    store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS worktree_setup_choices(thread_id TEXT PRIMARY KEY, choice TEXT NOT NULL)",
      ),
    );
  }
  /** Retry or Continue after a failed setup; applied when the thread's queue next resumes. */
  choose(id: ThreadId, choice: z.infer<typeof Choice>): "settled" | undefined {
    if (this.store.getThread(id)?.details?.worktreeSetup?.state !== "failed") return "settled";
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR REPLACE INTO worktree_setup_choices VALUES (?,?)")
        .run(id, Choice.parse(choice)),
    );
    return undefined;
  }
  /** Run setup in `checkout` when it was just made, or its earlier setup failed. */
  async run(
    id: ThreadId,
    checkout: string,
    made: boolean,
    policy: { runCommands: boolean },
  ): Promise<void> {
    const failed = this.store.getThread(id)?.details?.worktreeSetup?.state === "failed";
    if (!made && !failed) return;
    const choice = this.take(id);
    if (choice === "continue") return this.publish(id, undefined);
    if (!policy.runCommands) {
      this.publish(id, { state: "skipped", reason: "read_only", details: [], at: this.now() });
      return;
    }
    const log = new OutputLog();
    try {
      await runSetupScript(
        this.git,
        checkout,
        undefined,
        { stderr: (chunk) => log.write(chunk) },
        () => {},
      );
    } catch (error) {
      log.flush();
      this.publish(id, { state: "failed", details: [...log.lines], at: this.now() });
      throw new Error("setup_failed", { cause: error });
    }
    this.publish(id, undefined);
  }
  private take(id: ThreadId): z.infer<typeof Choice> | undefined {
    return this.store.atomic((db) => {
      const row = db.prepare("SELECT choice FROM worktree_setup_choices WHERE thread_id=?").get(id);
      db.prepare("DELETE FROM worktree_setup_choices WHERE thread_id=?").run(id);
      return row ? Choice.parse(row.choice) : undefined;
    });
  }
  private publish(id: ThreadId, setup: WorktreeSetup | undefined): void {
    const current = this.store.getThread(id);
    if (!current) return;
    const { worktreeSetup, ...rest } = current.details ?? {};
    if (!setup && !worktreeSetup) return;
    const details: ThreadDetails = setup ? { ...rest, worktreeSetup: setup } : rest;
    this.store.appendEvents(
      id,
      [{ type: "thread.client.updated", changes: { details } }],
      this.now(),
    );
  }
}
