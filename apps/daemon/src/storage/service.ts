import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  StorageKind,
  StoragePlan,
  StorageRequest,
  StorageRetention,
  type StorageApply,
  type StorageCompaction,
  type StorageUsage,
  type StorageResult,
} from "@ace/protocol";
import { initializeThreadCleanup } from "../thread-cleanup-journal.ts";
import { StorageInventory } from "./inventory.ts";
import { StorageJournal, type CleanupJournal, type CompactionJournal } from "./journal.ts";
import { planStorageItem } from "./planner.ts";
import { applyStorageItems, compactStorage, type CompactionLimits } from "./apply.ts";
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
  private limits: CompactionLimits;
  constructor(owner: StorageOwner, limits: Partial<CompactionLimits> = {}) {
    this.owner = owner;
    this.limits = { chunkPages: 256, maxChunks: 4096, pause: () => setImmediate(), ...limits };
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
      return {
        categories: StorageKind.options.map((kind) => {
          const items = candidates.filter((candidate) => candidate.kind === kind);
          return {
            kind,
            bytes: items.reduce((sum, item) => sum + item.bytes, 0),
            items: items.length,
          };
        }),
        ...(await this.database()),
        measuredAt: this.owner.now(),
        complete,
      };
    });
  }
  /** File and WAL bytes on disk, plus free pages SQLite could hand back. */
  private async database() {
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
    return { databaseBytes, reclaimableDatabaseBytes: page * free };
  }
  /**
   * Admin-only database compaction. Never part of retention apply. An unfinished journal
   * entry is resumed first; an interrupted full rebuild needs a fresh confirmation.
   */
  compact(
    device: string,
    input: { mode?: "incremental" | "full"; confirm?: boolean },
    allowed = () => true,
  ): Promise<StorageCompaction> {
    return this.serial(async () => {
      const mode = input.mode ?? "incremental";
      if (!allowed()) throw new Error("storage_forbidden");
      let state = this.journal.unfinishedCompaction();
      if (state?.state === "interrupted") {
        if (mode !== "full" || input.confirm !== true) return this.compaction(state);
        state.state = "running";
      }
      if (!state) {
        if (mode === "full" && input.confirm !== true)
          throw new Error("storage_confirmation_required");
        state = {
          id: this.owner.id(),
          owner: device,
          mode,
          state: "running",
          phase: "vacuum",
          chunks: 0,
          databaseBytesBefore: (await this.database()).databaseBytes,
          fullRequired: false,
          checkpointed: false,
        };
      }
      const admitted = state;
      await this.owner.store.write(() => this.journal.saveCompaction(admitted));
      await compactStorage(
        this.owner,
        this.journal,
        state,
        this.limits,
        () => !this.closed && allowed(),
      );
      return this.compaction(state);
    });
  }
  abandonCompaction(id: string): Promise<StorageCompaction> {
    return this.serial(async () => {
      const state = this.journal.compaction(id);
      if (!state) throw new Error("storage_plan_not_found");
      if (state.state === "running" || state.state === "interrupted") {
        state.state = "abandoned";
        const settled = state;
        await this.owner.store.write(() => this.journal.saveCompaction(settled));
      }
      return this.compaction(state);
    });
  }
  private async compaction(state: CompactionJournal): Promise<StorageCompaction> {
    return {
      id: state.id,
      mode: state.mode,
      state: state.state === "running" ? "pending" : state.state,
      fullRequired: state.fullRequired,
      databaseBytesBefore: state.databaseBytesBefore,
      ...(await this.database()),
      checkpointed: state.checkpointed,
    };
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
        this.journal.save(journal);
      }
      return this.run(journal, allowed);
    });
  }
  private run(journal: CleanupJournal, allowed: () => boolean): Promise<StorageApply> {
    return applyStorageItems(
      this.owner,
      this.inventory,
      this.journal,
      journal,
      () => !this.closed && allowed(),
    );
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
    return this.apply("storage:scheduler", plan.id, plan.revision, allowed);
  }
  async resume(allowed: (reviewer: string) => boolean = () => true): Promise<void> {
    for (const id of this.journal.pending()) {
      const journal = this.journal.get(id);
      if (journal) await this.serial(() => this.run(journal, () => allowed(journal.owner)));
    }
    const compaction = this.journal.unfinishedCompaction();
    if (compaction?.state !== "running") return;
    // A full rebuild was confirmed for one attempt only; it waits for a new confirmation.
    if (compaction.mode === "full") {
      compaction.state = "interrupted";
      await this.owner.store.write(() => this.journal.saveCompaction(compaction));
      return;
    }
    if (allowed(compaction.owner))
      await this.serial(() =>
        compactStorage(this.owner, this.journal, compaction, this.limits, () => !this.closed),
      );
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
            apply: await this.apply(device, op.planId, op.revision, allowed),
          };
          break;
        case "cleanup.status":
          result = { kind: "apply", apply: this.status(device, op.planId) };
          break;
        case "cleanup.compact":
          result = { kind: "compaction", compaction: await this.compact(device, op, allowed) };
          break;
        case "cleanup.compactAbandon":
          result = {
            kind: "compaction",
            compaction: await this.abandonCompaction(op.compactionId),
          };
          break;
      }
      if (!allowed()) throw new Error("storage_forbidden");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      result = {
        kind: "error",
        code:
          message === "storage_busy" || message === "Store is busy"
            ? "busy"
            : message === "storage_confirmation_required"
              ? "invalid_request"
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
  stop(): void {
    this.closed = true;
  }
  async close(): Promise<void> {
    this.stop();
    await this.tail;
    await this.inventory.files.close();
  }
}
