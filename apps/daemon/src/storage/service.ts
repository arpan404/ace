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
import { RETENTION_REVIEWER, retentionKinds, retentionPolicy } from "./data-retention-policy.ts";

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
  private closing: Promise<void> | undefined;
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
   * Admin-only incremental compaction. Never part of retention apply. An unfinished
   * journal entry is resumed rather than replaced.
   */
  compact(device: string, allowed = () => true): Promise<StorageCompaction> {
    return this.serial(async () => {
      if (!allowed()) throw new Error("storage_forbidden");
      const state = this.journal.unfinishedCompaction() ?? {
        id: this.owner.id(),
        owner: device,
        state: "running" as const,
        phase: "vacuum" as const,
        chunks: 0,
        databaseBytesBefore: (await this.database()).databaseBytes,
        incrementalUnavailable: false,
        checkpointed: false,
      };
      await this.owner.store.write(() => this.journal.saveCompaction(state));
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
  /** Stop resuming an unfinished compaction. Chunks already released stay released. */
  abandonCompaction(id: string): Promise<StorageCompaction> {
    return this.serial(async () => {
      const state = this.journal.compaction(id);
      if (!state) throw new Error("storage_plan_not_found");
      if (state.state === "running") {
        state.state = "abandoned";
        await this.owner.store.write(() => this.journal.saveCompaction(state));
      }
      return this.compaction(state);
    });
  }
  private async compaction(state: CompactionJournal): Promise<StorageCompaction> {
    return {
      id: state.id,
      state: state.state === "running" ? "pending" : state.state,
      incrementalUnavailable: state.incrementalUnavailable,
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
      const draft = await this.draft(device, input);
      this.journal.admit(draft, draft.plan.createdAt);
      return draft.plan;
    });
  }
  /** Inventory and eligibility for one bounded plan, without admitting it to the journal. */
  private async draft(
    device: string,
    input: Extract<StorageRequest["operation"], { op: "cleanup.plan" }>,
  ): Promise<CleanupJournal> {
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
    return {
      plan,
      owner: device,
      state: "review",
      entries: bounded.map(({ item, candidate }) => ({
        item,
        fingerprint: candidate.fingerprint,
        target: candidate.target,
        state: "pending",
      })),
    };
  }
  /**
   * Automatic data retention: one bounded plan of idle threads, unused attachments and log
   * files older than `days`, applied under the scheduler's own reviewer identity. Nothing is
   * journaled when nothing is eligible, and settled plans are dropped, so periodic passes
   * never fill the plan journal. The same protections as reviewed cleanup apply, rechecked
   * at removal time.
   */
  retain(days: number, allowed: () => boolean): Promise<{ removed: number; complete: boolean }> {
    return this.serial(async () => {
      if (!allowed()) return { removed: 0, complete: false };
      const draft = await this.draft(RETENTION_REVIEWER, {
        op: "cleanup.plan",
        kinds: [...retentionKinds],
        retention: retentionPolicy(days),
        forceItems: [],
      });
      if (!draft.entries.some((entry) => entry.item.disposition === "remove"))
        return { removed: 0, complete: draft.plan.complete };
      draft.entries = draft.entries.filter((entry) => entry.item.disposition === "remove");
      draft.state = "applying";
      this.journal.admit(draft, draft.plan.createdAt);
      const result = await this.run(draft, allowed);
      if (result.state !== "pending") this.journal.discard(draft.plan.id);
      return {
        removed: result.items.filter((item) => item.state === "removed").length,
        complete: result.state !== "pending" && draft.plan.complete,
      };
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
    if (compaction?.state === "running" && allowed(compaction.owner))
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
          result = { kind: "compaction", compaction: await this.compact(device, allowed) };
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
  /** Idempotent: closing the pinned root again could close a descriptor number reused elsewhere. */
  close(): Promise<void> {
    this.stop();
    return (this.closing ??= this.tail.then(() => this.inventory.files.close()));
  }
}
