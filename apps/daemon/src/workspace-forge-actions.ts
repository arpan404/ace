import { ForgeResourceOwner, forgeResourceKey } from "./forge-resource-owner.ts";
import { ForgeError, WriteDispatch, uncertainWriteExpired, type GitHubForge } from "@ace/forge";
import type { CommandResult, ForgePrRef, ForgePrStatus, ForgeMergeState } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";
import {
  ForgeWriteReceipt,
  actionFamily,
  observedWrite,
  observedMergeState,
  mergeStateWrite,
  writeTarget,
  type ForgePrWrite,
} from "./forge-action-observation.ts";

type Settled = "reconciled" | "failed";
const settled = (receipt: ForgeWriteReceipt) =>
  receipt.phase === "reconciled" || receipt.phase === "failed";

/**
 * A fence per PR and action family (merge, review request, reply) survives new command IDs and
 * daemon restarts. An uncertain write fences only retries of its own family, and only until a
 * complete read after the uncertainty window still shows no trace of it.
 */
export class WorkspaceForgeActions {
  private store: Store;
  private live = new Set<string>();
  private owner: ForgeResourceOwner;
  private now: () => number;
  constructor(store: Store, owner: ForgeResourceOwner, now: () => number) {
    this.owner = owner;
    this.store = store;
    this.now = now;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS forge_pr_write_receipts (
      resource TEXT NOT NULL, family TEXT NOT NULL, receipt TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(resource, family)
    )`),
    );
  }
  private key(pr: ForgePrRef): string {
    return forgeResourceKey(pr);
  }
  private read(key: string, family: string): ForgeWriteReceipt | undefined {
    const row = this.store.atomic((db) =>
      db
        .prepare("SELECT receipt FROM forge_pr_write_receipts WHERE resource=? AND family=?")
        .get(key, family),
    );
    return row ? ForgeWriteReceipt.parse(JSON.parse(z.string().parse(row.receipt))) : undefined;
  }
  private open(key: string): ForgeWriteReceipt[] {
    return this.store
      .atomic((db) =>
        db.prepare("SELECT receipt FROM forge_pr_write_receipts WHERE resource=?").all(key),
      )
      .map((row) => ForgeWriteReceipt.parse(JSON.parse(z.string().parse(row.receipt))))
      .filter((receipt) => !settled(receipt));
  }
  private save(key: string, receipt: ForgeWriteReceipt): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO forge_pr_write_receipts(resource,family,receipt) VALUES (?,?,?) ON CONFLICT(resource,family) DO UPDATE SET receipt=excluded.receipt,generation=forge_pr_write_receipts.generation+1",
        )
        .run(key, actionFamily(receipt.action), JSON.stringify(receipt)),
    );
  }
  private settle(key: string, receipt: ForgeWriteReceipt, phase: Settled): void {
    this.save(key, { ...receipt, phase });
  }
  private generation(key: string): number {
    const row = this.store.atomic((db) =>
      db
        .prepare(
          "SELECT COALESCE(SUM(generation),-1) AS total FROM forge_pr_write_receipts WHERE resource=?",
        )
        .get(key),
    );
    return z.number().int().parse(row?.total);
  }
  readDetail<T extends { status: ForgePrStatus }>(pr: ForgePrRef, read: () => Promise<T>) {
    return this.guardedRead(pr, read, (receipt, value) => observedWrite(receipt, value.status));
  }
  readMergeState(pr: ForgePrRef, read: () => Promise<ForgeMergeState>) {
    // Merge state cannot show a reply or a review request; those stay as they are.
    return this.guardedRead(pr, read, (receipt, value) =>
      actionFamily(receipt.action) === "merge"
        ? observedMergeState(receipt.action, value)
        : undefined,
    );
  }
  private async guardedRead<T>(
    pr: ForgePrRef,
    read: () => Promise<T>,
    observed: (receipt: ForgeWriteReceipt, value: T) => boolean | undefined,
  ) {
    const key = this.key(pr);
    const generation = this.generation(key);
    const duringWrite = this.live.has(key);
    const value = await read();
    // No await separates validation from observation. A stale read cannot retire a newer fence.
    return this.store.atomic(() => {
      if (generation !== this.generation(key) || (duringWrite && !this.live.has(key)))
        throw new ForgeError("conflict");
      return { value, writeState: this.observe(key, (receipt) => observed(receipt, value)) };
    });
  }
  /** Settle what a complete read proves; report any write that is still in doubt. */
  private observe(
    key: string,
    observed: (receipt: ForgeWriteReceipt) => boolean | undefined,
  ): "pending" | "uncertain" | undefined {
    if (this.live.has(key)) return "pending";
    let state: "uncertain" | undefined;
    for (const receipt of this.open(key)) {
      const seen = observed(receipt);
      const outcome =
        seen === undefined
          ? receipt.phase === "accepted"
            ? "reconciled"
            : undefined
          : this.outcome(receipt, seen);
      if (outcome) this.settle(key, receipt, outcome);
      else state = "uncertain";
    }
    return state;
  }
  /** Seen or acknowledged: reconciled. Unseen past the window: it never landed. */
  private outcome(receipt: ForgeWriteReceipt, observed: boolean): Settled | undefined {
    if (receipt.phase === "accepted" || observed) return "reconciled";
    return uncertainWriteExpired(receipt.at, this.now()) ? "failed" : undefined;
  }
  private async status(
    action: ForgeWriteReceipt["action"],
    backend: GitHubForge,
    signal: AbortSignal,
  ): Promise<ForgePrStatus> {
    const target =
      action.type === "forge.hosted.merge" || action.type === "forge.hosted.merge-state"
        ? action.pr
        : "link" in action
          ? action.link.pr
          : undefined;
    if (!target) throw new ForgeError("invalid_data");
    const status = await backend.status(target.number, signal);
    return mergeStateWrite(action)
      ? { ...status, mergeState: await backend.prMergeState(target.number, signal) }
      : status;
  }
  async execute(
    action: ForgePrWrite,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
    publish: (status: ForgePrStatus) => void,
  ): Promise<Omit<CommandResult, "commandId">> {
    const pr = writeTarget(action);
    const key = this.key(pr);
    if (this.live.has(key) || this.live.size >= 16)
      return { ok: false, error: "forge_write_pending" };
    const release = this.owner.acquire(pr);
    this.live.add(key);
    try {
      const previous = this.read(key, actionFamily(action));
      if (previous && !settled(previous)) {
        // Reconcile the earlier write of this family first. It is never repeated while in doubt.
        const status = await this.status(previous.action, backend, signal);
        const outcome = this.outcome(previous, observedWrite(previous, status));
        if (!outcome) return { ok: false, error: "forge_write_uncertain" };
        this.settle(key, previous, outcome);
        if (outcome === "reconciled") {
          publish(status);
          return { ok: true, pr, prStatus: status, code: "forge_action_reconciled" };
        }
        // Expired without a trace: this command is a fresh write.
      }
      return await this.write(action, key, backend, signal, allowed, publish);
    } finally {
      this.live.delete(key);
      release();
    }
  }
  private async write(
    action: ForgePrWrite,
    key: string,
    backend: GitHubForge,
    signal: AbortSignal,
    allowed: () => boolean,
    publish: (status: ForgePrStatus) => void,
  ): Promise<Omit<CommandResult, "commandId">> {
    const pr = writeTarget(action);
    const actor =
      action.type === "forge.comment.reply" ? await backend.currentUser(signal) : undefined;
    signal.throwIfAborted();
    if (!allowed()) return { ok: false, error: "forbidden" };
    const baseline =
      action.type === "forge.comment.reply" ? await backend.status(pr.number, signal) : undefined;
    signal.throwIfAborted();
    if (!allowed()) return { ok: false, error: "forbidden" };
    const draft: Omit<ForgeWriteReceipt, "at"> = {
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
    let receipt: ForgeWriteReceipt = { ...draft, at: this.now() };
    const dispatch = new WriteDispatch(() => {
      signal.throwIfAborted();
      if (!allowed()) throw new ForgeError("forbidden", undefined, false);
      receipt = { ...draft, at: this.now() };
      this.save(key, receipt);
    });
    let mergeState: ForgeMergeState | undefined;
    try {
      if (action.type === "forge.comment.reply")
        await backend.replyComment(pr.number, action.commentId, action.body, signal, dispatch);
      else if (action.type === "forge.review.request")
        await backend.requestReviews(pr.number, action.reviewers, signal, dispatch);
      else if (action.type === "forge.pr.merge" || action.type === "forge.hosted.merge")
        await backend.merge(pr.number, action.headSha, action.method, signal, dispatch);
      else {
        const change = mergeStateWrite(action);
        if (!change) throw new ForgeError("invalid_data", undefined, false);
        mergeState = await backend.changeMergeState(
          pr.number,
          change.headSha,
          change.action,
          change.method,
          signal,
          allowed,
          dispatch,
        );
      }
    } catch (error) {
      if (dispatch.definitelyFailed) {
        this.settle(key, receipt, "failed");
        throw error;
      }
      return { ok: false, error: "forge_write_uncertain" };
    }
    // Acknowledgement is durable before any follow-up read or projection can fail.
    const accepted: ForgeWriteReceipt = { ...receipt, phase: "accepted" };
    this.save(key, accepted);
    try {
      const status = {
        ...(await backend.status(pr.number, signal)),
        ...(mergeStateWrite(action)
          ? { mergeState: mergeState ?? (await backend.prMergeState(pr.number, signal)) }
          : {}),
      };
      publish(status);
      this.settle(key, accepted, "reconciled");
      return { ok: true, pr, prStatus: status };
    } catch {
      return { ok: true, pr, code: "forge_status_unavailable" };
    }
  }
}
