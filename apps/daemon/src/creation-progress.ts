import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { createRedactor } from "@ace/redaction";
import {
  Command,
  ThreadId,
  WorktreeCreationProgress,
  type DeviceId,
  type ServerMessage,
} from "@ace/protocol";
import type { Store } from "./store.ts";

type Progress = WorktreeCreationProgress;
type Send = (message: ServerMessage) => void;
/** Bounded line framing precedes redaction, including secrets split across process chunks. */
export class CreationProgress {
  readonly controller = new AbortController();
  action: "cancel" | "local" | undefined;
  active = true;
  private decoder = new StringDecoder("utf8");
  private line = "";
  private oversized = false;
  private detailBytes = 0;
  private redact: (text: string) => string;
  private now: () => number;
  private publish: (progress: Progress) => void;
  progress: Progress;
  constructor(
    command: Command,
    attempt: number,
    now: () => number,
    publish: (progress: Progress) => void,
  ) {
    this.now = now;
    this.publish = publish;
    this.redact = createRedactor({ home: homedir(), env: process.env });
    const p = command.payload;
    this.progress = {
      commandId: command.id,
      ...("threadId" in p && p.threadId ? { threadId: ThreadId.parse(p.threadId) } : {}),
      attempt,
      state: "running",
      step: "preparing",
      startedAt: now(),
      elapsedMs: 0,
      steps: [],
      details: [],
      cleanupComplete: false,
      actions: ["cancel", "local"],
    };
    this.update("preparing");
  }
  update(step: Progress["step"], percent?: number): void {
    const time = this.now();
    const previous = this.progress.steps.at(-1);
    if (previous) previous.elapsedMs = Math.max(0, time - previous.startedAt);
    if (this.progress.step !== step || !previous) {
      this.flush();
      this.progress.steps.push({ step, startedAt: time, elapsedMs: 0 });
      delete this.progress.percent;
    }
    this.progress.step = step;
    if (percent !== undefined)
      this.progress.percent = Math.max(this.progress.percent ?? 0, percent);
    this.emit();
  }
  readonly stderr = (chunk: Buffer): void => {
    for (const char of this.decoder.write(chunk)) {
      if (char === "\n" || char === "\r") this.flush();
      else if (!this.oversized) {
        this.line += char;
        if (this.line.length > 4096) {
          this.line = "";
          this.oversized = true;
        }
      }
    }
    this.emit();
  };
  private flush(): void {
    if (this.line || this.oversized) {
      const clean = this.oversized
        ? "[Oversized output line omitted]"
        : stripVTControlCharacters(this.redact(this.line));
      const detail = clean.length > 1024 ? "[Oversized output line omitted]" : clean;
      this.progress.details.push(detail);
      // Bound bytes independently of UTF-16 length, including JSON's worst-case escaping.
      this.detailBytes += Buffer.byteLength(JSON.stringify(detail));
      while (this.progress.details.length > 200 || this.detailBytes > 131072) {
        const removed = this.progress.details.shift();
        if (removed !== undefined) this.detailBytes -= Buffer.byteLength(JSON.stringify(removed));
      }
    }
    this.line = "";
    this.oversized = false;
  }
  stop(action: "cancel" | "local"): void {
    this.action = action;
    this.progress.state = "cancelling";
    this.progress.actions = [];
    this.emit();
    this.controller.abort();
  }
  finish(state: Progress["state"], cleanupComplete: boolean): void {
    this.active = false;
    this.flush();
    this.progress.state = state;
    this.progress.cleanupComplete = cleanupComplete;
    this.progress.actions =
      cleanupComplete && (state === "failed" || state === "cancelled") ? ["retry", "local"] : [];
    if (state === "failed")
      this.progress.message =
        "We couldn't create the worktree. Try again or use the local checkout.";
    if (state === "cancelled")
      this.progress.message = "Worktree creation cancelled. Your first message is still queued.";
    if (!cleanupComplete)
      this.progress.message = "Worktree cleanup needs attention before this checkout can be used.";
    this.emit();
  }
  private emit(): void {
    const time = this.now();
    this.progress.elapsedMs = Math.max(0, time - this.progress.startedAt);
    const current = this.progress.steps.at(-1);
    if (current) current.elapsedMs = Math.max(0, time - current.startedAt);
    this.publish(this.progress);
  }
}

/** Drafts survive reconnects/restarts; only their authenticated device can read or control them. */
export class CreationDrafts {
  private live = new Map<string, CreationProgress>();
  constructor(privateStore: Store, privateNow: () => number) {
    this.store = privateStore;
    this.now = privateNow;
    this.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS worktree_creation_drafts (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, command TEXT NOT NULL, progress TEXT NOT NULL
    )`),
    );
  }
  private store: Store;
  private now: () => number;
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
    const progress = WorktreeCreationProgress.parse(JSON.parse(row.progress));
    const operation = this.live.get(id);
    if (!operation && ["running", "cancelling"].includes(progress.state)) {
      progress.state = "failed";
      progress.message = "Worktree creation was interrupted. Try again or use the local checkout.";
      progress.actions = ["retry", "local"];
      // The creation journal and Git admission fence are checked again before either action.
      progress.cleanupComplete = true;
    }
    return {
      command: Command.parse(JSON.parse(row.command)),
      progress,
      ...(operation ? { operation } : {}),
    };
  }
  begin(command: Command, device: DeviceId, send: Send): CreationProgress {
    if (this.live.has(command.id)) throw new Error("thread_creation_in_progress");
    const previous = this.get(command.id, device);
    this.store.atomic((db) => {
      const owner = db
        .prepare("SELECT device FROM worktree_creation_drafts WHERE id=?")
        .get(command.id);
      if (owner && owner.device !== device) throw new Error("forbidden");
      if (
        !previous &&
        Number(db.prepare("SELECT COUNT(*) AS count FROM worktree_creation_drafts").get()?.count) >=
          16
      )
        throw new Error("workspace_busy");
    });
    const operation = new CreationProgress(
      command,
      (previous?.progress.attempt ?? 0) + 1,
      this.now,
      (progress) => {
        this.store.atomic((db) =>
          db
            .prepare("INSERT OR REPLACE INTO worktree_creation_drafts VALUES (?,?,?,?)")
            .run(command.id, device, JSON.stringify(command), JSON.stringify(progress)),
        );
        if ((progress.state === "done" || progress.state === "local") && progress.threadId) {
          const thread = this.store.getThread(progress.threadId);
          if (thread)
            this.store.appendEvents(
              progress.threadId,
              [
                {
                  type: "thread.client.updated",
                  changes: {
                    details: { ...thread.details, worktreeCreation: progress },
                  },
                },
              ],
              this.now(),
            );
        }
        send({ type: "worktree.creation.progress", ...progress });
      },
    );
    this.live.set(command.id, operation);
    return operation;
  }
  release(id: string, settled: boolean): void {
    this.live.delete(id);
    if (settled)
      this.store.atomic((db) =>
        db.prepare("DELETE FROM worktree_creation_drafts WHERE id=?").run(id),
      );
  }
}
