import { Command, DeviceId, WorktreeCreationProgress, type ServerMessage } from "@ace/protocol";
import { CreationProgress } from "./creation-progress.ts";
import type { Store } from "./store.ts";

type Progress = WorktreeCreationProgress;
type Send = (message: ServerMessage) => void;
export interface CreationRecovery {
  ready(): Promise<void>;
  cleanupComplete(command: Command): boolean;
  /** Remove what a forgotten start kept (a worktree whose setup failed). Never throws. */
  discard(command: Command): Promise<void>;
}
/** Settled starts are forgotten after an hour, so failures never fill the table. */
export const settledRetentionMs = 3_600_000;
/** At most this many starts may be running or awaiting cleanup at once. */
const unsettledLimit = 16;
/** Settled rows kept regardless of age; the oldest go first. */
const settledLimit = 64;

const prOnlyPayload = (command: Command) => {
  const p = command.payload;
  return (
    p.type === "forge.pr.worktree" ||
    ((p.type === "thread.create" || p.type === "thread.prepare") && Boolean(p.pullRequest))
  );
};
/** Failed or cancelled with nothing left on disk to clean up: the person may only retry it. */
const settledState = (progress: Progress) =>
  progress.cleanupComplete && (progress.state === "failed" || progress.state === "cancelled");

/** Drafts survive reconnects/restarts; only their authenticated device can read or control them. */
export class CreationDrafts {
  private live = new Map<string, CreationProgress>();
  private sends = new Map<string, Set<Send>>();
  private recovery: CreationRecovery;
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number, recovery: CreationRecovery) {
    this.store = store;
    this.now = now;
    this.recovery = recovery;
    this.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS worktree_creation_drafts (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, command TEXT NOT NULL, progress TEXT NOT NULL
    )`),
    );
  }
  get(
    id: string,
    device: DeviceId,
  ): { command: Command; progress: Progress; operation?: CreationProgress } | undefined {
    const row = this.store.atomic((db) =>
      db
        .prepare("SELECT command,progress FROM worktree_creation_drafts WHERE id=? AND device=?")
        .get(id, device),
    );
    if (!row || typeof row.command !== "string" || typeof row.progress !== "string") return;
    const command = Command.parse(JSON.parse(row.command));
    const p = command.payload;
    const prOnly = prOnlyPayload(command);
    const progress = WorktreeCreationProgress.parse(JSON.parse(row.progress));
    const operation = this.live.get(id);
    if (
      !operation &&
      (["running", "cancelling"].includes(progress.state) ||
        (progress.state === "failed" &&
          !progress.cleanupComplete &&
          this.recovery.cleanupComplete(command)))
    ) {
      const interrupted = ["running", "cancelling"].includes(progress.state);
      progress.state = "failed";
      if (interrupted || !progress.error)
        progress.message = prOnly
          ? "PR preparation was interrupted. Refresh the PR and try Work on PR again."
          : "Worktree creation was interrupted. Try again or use the local checkout.";
      progress.cleanupComplete = this.recovery.cleanupComplete(command);
      progress.actions =
        !progress.cleanupComplete || p.type === "forge.pr.worktree"
          ? []
          : prOnly
            ? ["retry"]
            : ["retry", "local"];
      if (!progress.cleanupComplete)
        progress.message = "Worktree cleanup needs attention before this checkout can be used.";
      this.store.atomic((db) =>
        db
          .prepare("UPDATE worktree_creation_drafts SET progress=? WHERE id=? AND device=?")
          .run(JSON.stringify(progress), id, device),
      );
      if (p.type === "forge.pr.worktree") {
        const thread = this.store.getThread(p.threadId);
        if (thread?.details?.worktreeCreation?.commandId === command.id)
          this.store.appendEvents(
            p.threadId,
            [
              {
                type: "thread.client.updated",
                changes: { details: { ...thread.details, worktreeCreation: progress } },
              },
            ],
            this.now(),
          );
      }
    }
    return { command, progress, ...(operation ? { operation } : {}) };
  }
  /** A replay of a running start from the same device follows it instead of starting again. */
  attach(id: string, device: DeviceId, send: Send): CreationProgress | undefined {
    const operation = this.live.get(id);
    if (!operation?.active || !this.get(id, device)) return undefined;
    this.sends.get(id)?.add(send);
    send({ type: "worktree.creation.progress", ...operation.progress });
    return operation;
  }
  detach(id: string, send: Send): void {
    this.sends.get(id)?.delete(send);
  }
  async begin(command: Command, device: DeviceId, send: Send): Promise<CreationProgress> {
    // The physical journal settles first. Missing cleanup evidence never becomes a free slot.
    await this.recovery.ready();
    if (this.live.has(command.id)) throw new Error("thread_creation_in_progress");
    const previous = this.get(command.id, device);
    let unsettled = 0;
    let blockedTarget = false;
    const settled: { id: string; command: Command; at: number }[] = [];
    for (const row of this.rows()) {
      if (row.id === command.id) continue;
      if (this.live.has(row.id)) {
        unsettled++;
        continue;
      }
      const old = this.get(row.id, row.device);
      if (!old) continue;
      if (settledState(old.progress)) {
        settled.push({
          id: row.id,
          command: old.command,
          at: old.progress.startedAt + old.progress.elapsedMs,
        });
        continue;
      }
      unsettled++;
      if (
        old.command.payload.type === "forge.pr.worktree" &&
        command.payload.type === "forge.pr.worktree" &&
        old.command.payload.threadId === command.payload.threadId
      )
        blockedTarget = true;
    }
    this.forget(settled);
    if (blockedTarget) throw new Error("workspace_cleanup_required");
    this.store.atomic((db) => {
      const owner = db
        .prepare("SELECT device FROM worktree_creation_drafts WHERE id=?")
        .get(command.id);
      if (owner && owner.device !== device) throw new Error("forbidden");
      if (!previous && unsettled >= unsettledLimit) throw new Error("workspace_busy");
    });
    const sends = new Set<Send>([send]);
    this.sends.set(command.id, sends);
    const operation = new CreationProgress(
      command,
      (previous?.progress.attempt ?? 0) + 1,
      this.now,
      (progress) => this.publish(command, device, progress, sends),
    );
    this.live.set(command.id, operation);
    return operation;
  }
  release(id: string, settled: boolean): void {
    this.live.delete(id);
    this.sends.delete(id);
    if (settled)
      this.store.atomic((db) =>
        db.prepare("DELETE FROM worktree_creation_drafts WHERE id=?").run(id),
      );
  }
  /** The person went back to New thread: forget a settled start and what it kept. */
  dismiss(id: string, device: DeviceId): "not_found" | "busy" | undefined {
    const draft = this.get(id, device);
    if (!draft) return "not_found";
    if (draft.operation?.active || !settledState(draft.progress)) return "busy";
    this.drop(id, draft.command);
    return undefined;
  }
  private rows(): { id: string; device: DeviceId }[] {
    return this.store
      .atomic((db) => db.prepare("SELECT id,device FROM worktree_creation_drafts").all())
      .flatMap((row) =>
        typeof row.id === "string" && typeof row.device === "string"
          ? [{ id: row.id, device: DeviceId.parse(row.device) }]
          : [],
      );
  }
  /** Settled rows past their time limit, or beyond the newest few, go; so do their kept worktrees. */
  private forget(rows: { id: string; command: Command; at: number }[]): void {
    const now = this.now();
    const newest = rows.toSorted((a, b) => b.at - a.at);
    for (const [index, row] of newest.entries()) {
      const fresh = now - row.at < settledRetentionMs && index < settledLimit;
      if (!fresh || row.command.payload.type === "forge.pr.worktree")
        this.drop(row.id, row.command);
    }
  }
  private drop(id: string, command: Command): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM worktree_creation_drafts WHERE id=?").run(id),
    );
    void this.recovery.discard(command);
  }
  private publish(command: Command, device: DeviceId, progress: Progress, sends: Set<Send>) {
    this.store.atomic((db) =>
      db
        .prepare("INSERT OR REPLACE INTO worktree_creation_drafts VALUES (?,?,?,?)")
        .run(command.id, device, JSON.stringify(command), JSON.stringify(progress)),
    );
    if (
      (command.payload.type === "forge.pr.worktree" ||
        progress.state === "done" ||
        progress.state === "local") &&
      progress.threadId
    ) {
      const thread = this.store.getThread(progress.threadId);
      if (thread)
        this.store.appendEvents(
          progress.threadId,
          [
            {
              type: "thread.client.updated",
              changes: { details: { ...thread.details, worktreeCreation: progress } },
            },
          ],
          this.now(),
        );
    }
    for (const send of sends) send({ type: "worktree.creation.progress", ...progress });
  }
}
