import { ForgeError, WriteDispatch, repositoryKey, type GitHubForge } from "@ace/forge";
import type { CommandResult, ForgePrRef, ForgePrStatus } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";
import {
  ForgeWriteReceipt,
  observedWrite,
  type RemoteForgeAction,
} from "./forge-action-observation.ts";

/** A PR-wide fence survives new command IDs, different actions, and daemon restarts. */
export class WorkspaceForgeActions {
  private store: Store;
  private live = new Set<string>();
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS forge_action_receipts (
      resource TEXT PRIMARY KEY, receipt TEXT NOT NULL
    )`),
    );
    const columns = store.atomic((db) =>
      db.prepare("PRAGMA table_info(forge_action_receipts)").all(),
    );
    if (!columns.some((column) => column.name === "generation"))
      store.atomic((db) =>
        db.exec(
          "ALTER TABLE forge_action_receipts ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
        ),
      );
  }
  private key(pr: ForgePrRef): string {
    return JSON.stringify([repositoryKey(pr.repository), pr.number]);
  }
  private read(key: string): ForgeWriteReceipt | undefined {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT receipt FROM forge_action_receipts WHERE resource=?").get(key),
    );
    return row ? ForgeWriteReceipt.parse(JSON.parse(z.string().parse(row.receipt))) : undefined;
  }
  private save(key: string, receipt: ForgeWriteReceipt): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO forge_action_receipts(resource,receipt) VALUES (?,?) ON CONFLICT(resource) DO UPDATE SET receipt=excluded.receipt,generation=forge_action_receipts.generation+1",
        )
        .run(key, JSON.stringify(receipt)),
    );
  }
  private generation(key: string): number {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT generation FROM forge_action_receipts WHERE resource=?").get(key),
    );
    return row ? z.number().int().nonnegative().parse(row.generation) : -1;
  }
  async readDetail<T extends { status: ForgePrStatus }>(pr: ForgePrRef, read: () => Promise<T>) {
    const key = this.key(pr);
    const generation = this.generation(key);
    const duringWrite = this.live.has(key);
    const value = await read();
    // No await separates validation from observation. A stale read cannot retire a newer fence.
    return this.store.atomic(() => {
      if (generation !== this.generation(key) || (duringWrite && !this.live.has(key)))
        throw new ForgeError("conflict");
      return { value, writeState: this.observe(value.status) };
    });
  }
  private observe(status: ForgePrStatus): "pending" | "uncertain" | undefined {
    const key = this.key(status.ref);
    if (this.live.has(key)) return "pending";
    const receipt = this.read(key);
    if (!receipt || ["reconciled", "failed"].includes(receipt.phase)) return undefined;
    if (receipt.phase === "accepted" || observedWrite(receipt, status)) {
      this.save(key, { ...receipt, phase: "reconciled" });
      return undefined;
    }
    return "uncertain";
  }
  async execute(
    action: RemoteForgeAction,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
    publish: (status: ForgePrStatus) => void,
  ): Promise<Omit<CommandResult, "commandId">> {
    const pr = action.link.pr;
    const key = this.key(pr);
    if (this.live.has(key) || this.live.size >= 16)
      return { ok: false, error: "forge_write_pending" };
    const previous = this.read(key);
    this.live.add(key);
    try {
      if (previous && !["reconciled", "failed"].includes(previous.phase)) {
        // This command is reconciliation only. It never repeats the previous write.
        const status = await backend.status(pr.number, signal);
        if (previous.phase !== "accepted" && !observedWrite(previous, status))
          return { ok: false, error: "forge_write_uncertain" };
        this.save(key, { ...previous, phase: "reconciled" });
        publish(status);
        return { ok: true, pr, prStatus: status, code: "forge_action_reconciled" };
      }
      const actor =
        action.type === "forge.comment.reply" ? await backend.currentUser(signal) : undefined;
      signal.throwIfAborted();
      if (!allowed()) return { ok: false, error: "forbidden" };
      const baseline =
        action.type === "forge.comment.reply" ? await backend.status(pr.number, signal) : undefined;
      signal.throwIfAborted();
      if (!allowed()) return { ok: false, error: "forbidden" };
      const receipt: ForgeWriteReceipt = {
        action,
        phase: "pending",
        ...(actor ? { actor } : {}),
        ...(baseline && action.type === "forge.comment.reply"
          ? {
              replyBaseline: baseline.comments
                .filter(
                  (comment) => comment.kind === "inline" && comment.replyTo === action.commentId,
                )
                .map((comment) => comment.id),
            }
          : {}),
      };
      const dispatch = new WriteDispatch(() => {
        signal.throwIfAborted();
        if (!allowed()) throw new ForgeError("forbidden", undefined, false);
        this.save(key, receipt);
      });
      try {
        if (action.type === "forge.comment.reply")
          await backend.replyComment(pr.number, action.commentId, action.body, signal, dispatch);
        else if (action.type === "forge.review.request")
          await backend.requestReviews(pr.number, action.reviewers, signal, dispatch);
        else if (action.type === "forge.pr.merge")
          await backend.merge(pr.number, action.headSha, action.method, signal, dispatch);
        else
          await backend.enableAutoMerge(pr.number, action.headSha, action.method, signal, dispatch);
      } catch (error) {
        if (dispatch.definitelyFailed) {
          this.save(key, { ...receipt, phase: "failed" });
          throw error;
        }
        return { ok: false, error: "forge_write_uncertain" };
      }
      // Acknowledgement is durable before any follow-up read or projection can fail.
      const accepted: ForgeWriteReceipt = { ...receipt, phase: "accepted" };
      this.save(key, accepted);
      try {
        const status = await backend.status(pr.number, signal);
        publish(status);
        this.save(key, { ...accepted, phase: "reconciled" });
        return { ok: true, pr, prStatus: status };
      } catch {
        return { ok: true, pr, code: "forge_status_unavailable" };
      }
    } finally {
      this.live.delete(key);
    }
  }
}
