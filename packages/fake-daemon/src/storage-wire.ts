import { planStorageItem, type StorageCandidate } from "@ace/core";
import {
  StorageKind,
  StorageRetention,
  type StorageApply,
  type StoragePlan,
  type StorageRequest,
  type StorageResult,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
import type { FakeSettings } from "./services/settings.ts";

/** In-memory storage facts for UI fixtures; the shared planner owns eligibility. */
export class FakeStorageWire {
  private candidates: StorageCandidate[] = [];
  private plans = new Map<string, { plan: StoragePlan; owner: string; result?: StorageApply }>();
  private sequence = 0;
  private host: FakeServiceContext;
  private settings: FakeSettings;
  constructor(host: FakeServiceContext, settings: FakeSettings) {
    this.host = host;
    this.settings = settings;
  }
  seed(candidates: readonly StorageCandidate[]): void {
    this.candidates = candidates.map((entry) => ({ ...entry }));
  }
  handle(device: string, request: StorageRequest): StorageResult {
    const op = request.operation;
    let result: StorageResult["result"];
    const candidates = this.candidates.map((candidate) => ({
      ...candidate,
      protections: [
        ...candidate.protections,
        ...candidate.threadIds.flatMap((id) => {
          const thread = this.host.threads().find((entry) => entry.id === id);
          return [
            ...(thread?.pinned ? ["pinned" as const] : []),
            ...(thread && !["new", "done", "failed"].includes(thread.status.state)
              ? ["active_tree" as const]
              : []),
          ];
        }),
      ],
    }));
    if (op.op === "storage.usage")
      result = {
        kind: "usage",
        usage: {
          categories: StorageKind.options.map((kind) => {
            const items = candidates.filter((entry) => entry.kind === kind);
            return {
              kind,
              bytes: items.reduce((sum, entry) => sum + entry.bytes, 0),
              items: items.length,
            };
          }),
          databaseBytes: 0,
          reclaimableDatabaseBytes: 0,
          measuredAt: this.host.now(),
          complete: true,
        },
      };
    else if (op.op === "cleanup.plan") {
      const retention =
        op.retention ?? StorageRetention.parse(this.settings.get("storage.retention"));
      const selected = candidates.filter((entry) => !op.kinds || op.kinds.includes(entry.kind));
      const items = selected.map((entry) =>
        planStorageItem(entry, retention, this.host.now(), new Set(op.forceItems)),
      );
      const plan: StoragePlan = {
        id: `storage-${++this.sequence}`,
        revision: this.sequence.toString(16).padStart(64, "0"),
        createdAt: this.host.now(),
        expiresAt: this.host.now() + 900000,
        retention,
        items,
        bytes: items.reduce(
          (sum, entry) => sum + (entry.disposition === "remove" ? entry.bytes : 0),
          0,
        ),
        complete: true,
      };
      if (this.plans.size >= 64) {
        const oldest = this.plans.keys().next().value;
        if (oldest) this.plans.delete(oldest);
      }
      this.plans.set(plan.id, { plan, owner: device });
      result = { kind: "plan", plan };
    } else {
      const saved = this.plans.get(op.planId);
      if (!saved || saved.owner !== device)
        result = { kind: "error", code: "not_found", message: "Plan not found." };
      else {
        if (op.op === "cleanup.apply" && !saved.result) {
          const stale =
            saved.plan.revision !== op.revision ||
            saved.plan.expiresAt <= this.host.now() ||
            saved.plan.items.some((item) => {
              const current = candidates.find((entry) => entry.id === item.id);
              return (
                item.disposition === "remove" &&
                (!current ||
                  planStorageItem(
                    current,
                    saved.plan.retention,
                    this.host.now(),
                    new Set(item.forced ? [item.id] : []),
                  ).disposition !== "remove")
              );
            });
          saved.result = {
            planId: saved.plan.id,
            state: stale ? "stale" : "complete",
            compaction: !stale && op.compact ? "deferred" : "not_requested",
            ...(!stale && op.compact ? { compactionReason: "disabled" as const } : {}),
            items: saved.plan.items
              .filter((item) => item.disposition === "remove")
              .map((item) => ({
                id: item.id,
                state: stale ? "protected" : "removed",
                reason: stale ? "changed" : undefined,
              })),
          };
          if (!stale)
            this.candidates = this.candidates.filter(
              (entry) =>
                !saved.result?.items.some(
                  (item) => item.id === entry.id && item.state === "removed",
                ),
            );
        }
        result = {
          kind: "apply",
          apply: saved.result ?? {
            planId: saved.plan.id,
            state: "pending",
            items: [],
            compaction: "not_requested",
          },
        };
      }
    }
    return { type: "storage.result", requestId: request.requestId, result };
  }
}
