import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  StorageKind,
  StoragePlan,
  StorageRequest,
  StorageRetention,
  type StorageApply,
  type StorageUsage,
  type StorageResult,
} from "@ace/protocol";
import { initializeThreadCleanup } from "../thread-cleanup-journal.ts";
import { StorageInventory } from "./inventory.ts";
import { StorageJournal, type CleanupJournal } from "./journal.ts";
import { planStorageItem } from "./planner.ts";
import { executeStorageItem, fenceStorageItem } from "./executor.ts";
import { compactStorage } from "./compaction.ts";
import type { StorageOwner } from "./types.ts";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
/** One bounded serializer owns planning, apply and crash recovery, not provider execution. */
export class StorageService {
  private owner: StorageOwner;
  private inventory: StorageInventory;
  private journal: StorageJournal;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  constructor(owner: StorageOwner) {
    this.owner = owner;
    initializeThreadCleanup(owner.store);
    this.journal = new StorageJournal(owner.store);
    this.inventory = new StorageInventory(owner);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed || this.queued >= 8) return Promise.reject(new Error("storage_busy"));
    this.queued++;
    const task = this.tail.then(run).finally(() => {
      this.queued--;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  private async retention() {
    return StorageRetention.parse(
      (await this.owner.services.settings?.get("storage.retention", {}))?.value ?? {},
    );
  }
  usage(): Promise<StorageUsage> {
    return this.serial(async () => {
      const { candidates, complete } = await this.inventory.scan();
      let databaseBytes = 0;
      for (const name of ["events.sqlite", "events.sqlite-wal"]) {
        try {
          databaseBytes += (await stat(join(this.owner.root, name))).size;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      const store = this.owner.store;
      const page = Number(store.statement("PRAGMA page_size").get()?.page_size);
      const free = Number(store.statement("PRAGMA freelist_count").get()?.freelist_count);
      return {
        categories: StorageKind.options.map((kind) => {
          const items = candidates.filter((candidate) => candidate.kind === kind);
          return {
            kind,
            bytes: items.reduce((sum, item) => sum + item.bytes, 0),
            items: items.length,
          };
        }),
        databaseBytes,
        reclaimableDatabaseBytes: page * free,
        measuredAt: this.owner.now(),
        complete,
      };
    });
  }
  plan(
    device: string,
    input: Extract<StorageRequest["operation"], { op: "cleanup.plan" }> = {
      op: "cleanup.plan",
      forceItems: [],
    },
  ): Promise<StoragePlan> {
    return this.serial(async () => {
      const operation = StorageRequest.shape.operation.parse(input);
      if (operation.op !== "cleanup.plan") throw new Error("storage_invalid_request");
      const retention = operation.retention ?? (await this.retention());
      const kinds = new Set(operation.kinds ?? StorageKind.options);
      const force = new Set(operation.forceItems);
      const now = this.owner.now();
      const scan = await this.inventory.scan();
      const selected = scan.candidates
        .filter((candidate) => kinds.has(candidate.kind))
        .map((candidate) => ({
          candidate,
          item: planStorageItem(candidate, retention, now, force),
        }))
        .toSorted(
          (a, b) =>
            Number(a.item.disposition === "protect") - Number(b.item.disposition === "protect") ||
            a.item.modifiedAt - b.item.modifiedAt ||
            a.item.id.localeCompare(b.item.id),
        );
      const bounded: typeof selected = [];
      let publicBytes = 1024;
      for (const entry of selected) {
        const bytes = Buffer.byteLength(JSON.stringify(entry.item));
        if (bounded.length >= 256 || publicBytes + bytes > 512 * 1024) break;
        bounded.push(entry);
        publicBytes += bytes;
      }
      const document = {
        id: this.owner.id(),
        createdAt: now,
        expiresAt: now + 15 * 60000,
        retention,
        items: bounded.map((entry) => entry.item),
        bytes: bounded.reduce(
          (sum, entry) => sum + (entry.item.disposition === "remove" ? entry.item.bytes : 0),
          0,
        ),
        complete: scan.complete && selected.length === bounded.length,
      };
      const revision = createHash("sha256")
        .update(
          JSON.stringify({
            document,
            identities: bounded.map((entry) => entry.candidate.fingerprint),
          }),
        )
        .digest("hex");
      const plan = StoragePlan.parse({ ...document, revision });
      this.journal.admit(
        {
          plan,
          owner: device,
          state: "review",
          compact: false,
          compaction: "not_requested",
          entries: bounded.map(({ item, candidate }) => ({
            item,
            fingerprint: candidate.fingerprint,
            target: candidate.target,
            state: "pending",
          })),
        },
        now,
      );
      return plan;
    });
  }
  status(device: string, planId: string): StorageApply {
    return this.journal.result(this.owned(device, planId));
  }
  private owned(device: string, planId: string): CleanupJournal {
    const journal = this.journal.get(planId);
    if (!journal || journal.owner !== device) throw new Error("storage_plan_not_found");
    return journal;
  }
  apply(
    device: string,
    planId: string,
    revision: string,
    compact = false,
    allowed = () => true,
  ): Promise<StorageApply> {
    return this.serial(async () => {
      const journal = this.owned(device, planId);
      if (journal.plan.revision !== revision) throw new Error("storage_invalid_revision");
      if (journal.state === "complete" || journal.state === "stale")
        return this.journal.result(journal);
      if (!allowed()) throw new Error("storage_forbidden");
      if (journal.state === "review") {
        let valid = journal.plan.expiresAt > this.owner.now();
        for (const entry of journal.entries) {
          if (entry.item.disposition !== "remove") continue;
          const current = await this.inventory
            .inspect(entry.target, entry.item.kind)
            .catch((error: unknown) => {
              if (missing(error)) return undefined;
              throw error;
            });
          const item =
            current &&
            planStorageItem(
              current,
              journal.plan.retention,
              this.owner.now(),
              new Set(entry.item.forced ? [entry.item.id] : []),
            );
          if (
            !current ||
            current.fingerprint !== entry.fingerprint ||
            item?.disposition !== "remove"
          ) {
            valid = false;
            entry.state = "protected";
            entry.reason = item?.reasons[0] ?? "changed";
          }
        }
        if (!valid) {
          journal.state = "stale";
          this.journal.save(journal);
          return this.journal.result(journal);
        }
        journal.state = "applying";
        journal.compact = compact;
        this.journal.save(journal);
      }
      return this.run(journal, allowed);
    });
  }
  private async run(journal: CleanupJournal, allowed: () => boolean): Promise<StorageApply> {
    this.owner.cleanupPlanId = journal.plan.id;
    try {
      for (const entry of journal.entries) {
        if (this.closed || !allowed()) break;
        if (entry.item.disposition !== "remove" || ["removed", "protected"].includes(entry.state))
          continue;
        try {
          await this.owner.store.writable();
          // Even after a crash, current activity/pins remain authoritative. Only a running
          // effect may have already removed or tombstoned its exact reviewed target.
          const current = await this.inventory
            .inspect(entry.target, entry.item.kind)
            .catch((error: unknown) => {
              if (
                missing(error) ||
                (error instanceof Error && "code" in error && error.code === "worktree_not_found")
              )
                return undefined;
              throw error;
            });
          const item =
            current &&
            planStorageItem(
              current,
              journal.plan.retention,
              this.owner.now(),
              new Set(entry.item.forced ? [entry.item.id] : []),
            );
          if (
            (item?.disposition === "protect" &&
              !(
                entry.state === "running" &&
                entry.target.type === "thread" &&
                item.reasons.every((reason) => reason === "within_retention")
              )) ||
            (entry.state === "pending" && (!current || current.fingerprint !== entry.fingerprint))
          ) {
            entry.state = "protected";
            entry.reason = item?.reasons[0] ?? "changed";
            this.journal.save(journal);
            this.releaseFences(journal.plan.id);
            continue;
          }
          this.owner.store.atomic(() => {
            fenceStorageItem(this.owner, journal.plan.id, entry);
            entry.state = "running";
            this.journal.save(journal);
          });
          await executeStorageItem(this.owner, this.inventory, entry, allowed);
          await this.owner.afterRemove?.(entry.item.id);
          entry.state = "removed";
          delete entry.error;
        } catch (error) {
          // The durable running marker preserves uncertain effects. Retry/status can resume it.
          if (missing(error) && entry.target.type === "file") {
            entry.state = "removed";
            entry.reason = "already_removed";
          } else {
            const code =
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : undefined;
            entry.error = code?.match(/^[a-z_]{1,128}$/) ? code : "cleanup_pending";
            this.journal.save(journal);
            return this.journal.result(journal);
          }
        }
        this.owner.store.atomic(() => {
          this.journal.save(journal);
          this.releaseFences(journal.plan.id);
        });
      }
      if (
        journal.entries.some(
          (entry) =>
            entry.item.disposition === "remove" && ["pending", "running"].includes(entry.state),
        )
      )
        return this.journal.result(journal);
      if (journal.compact) journal.compaction = await compactStorage(this.owner);
      journal.state = "complete";
      this.journal.save(journal);
      return this.journal.result(journal);
    } finally {
      delete this.owner.cleanupPlanId;
    }
  }
  private releaseFences(id: string): void {
    this.owner.store.statement("DELETE FROM storage_cleanup_fences WHERE plan_id=?").run(id);
    this.owner.store.workspaceReservations.release(`storage:${id}`);
  }
  /** Automation hook. Host opt-in preauthorizes only the ordinary, non-forced retention policy. */
  async scheduledCleanup(allowed = () => true): Promise<StorageApply> {
    await this.resume(() => allowed());
    const pending = this.journal.pending()[0];
    if (pending) {
      const journal = this.journal.get(pending);
      if (journal) return this.journal.result(journal);
    }
    const plan = await this.plan("storage:scheduler");
    return this.apply("storage:scheduler", plan.id, plan.revision, false, allowed);
  }
  async resume(allowed: (reviewer: string) => boolean = () => true): Promise<void> {
    for (const id of this.journal.pending()) {
      const journal = this.journal.get(id);
      if (journal) await this.serial(() => this.run(journal, () => allowed(journal.owner)));
    }
  }
  async handle(device: string, value: unknown, allowed: () => boolean): Promise<StorageResult> {
    const request = StorageRequest.parse(value);
    const op = request.operation;
    let result: StorageResult["result"];
    try {
      if (!allowed()) throw new Error("storage_forbidden");
      switch (op.op) {
        case "storage.usage":
          result = { kind: "usage", usage: await this.usage() };
          break;
        case "cleanup.plan":
          result = { kind: "plan", plan: await this.plan(device, op) };
          break;
        case "cleanup.apply":
          result = {
            kind: "apply",
            apply: await this.apply(device, op.planId, op.revision, op.compact, allowed),
          };
          break;
        case "cleanup.status":
          result = { kind: "apply", apply: this.status(device, op.planId) };
          break;
      }
      if (!allowed()) throw new Error("storage_forbidden");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      result = {
        kind: "error",
        code:
          message === "storage_busy"
            ? "busy"
            : message === "storage_forbidden"
              ? "forbidden"
              : message === "storage_plan_not_found"
                ? "not_found"
                : "unavailable",
        message: "Storage operation could not finish. Refresh usage or resume the reviewed plan.",
      };
    }
    return { type: "storage.result", requestId: request.requestId, result };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.inventory.files.close();
  }
}
