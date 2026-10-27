import type { ClientCore } from "@ace/client";
import {
  LogMaxBytes,
  RetentionDays,
  StorageKind,
  StorageRetention,
  type StorageApply,
  type StorageCompaction,
  type StoragePlan,
  type StorageRequest,
  type StorageUsage,
} from "@ace/protocol";
import { itemCount, storageBytes, storageLabels, storageReasons } from "@ace/ui-core/host-care";
import { z } from "zod";
import { host } from "./host.ts";
import { HostProblem } from "./host-problem.ts";

/*
 * One machine's Storage page: what its data takes, a reviewed cleanup (preview, then a
 * confirmed removal that names what goes), compaction, and how long each kind of data is kept.
 * The web's words (`@ace/ui-core/host-care`); Swift draws what this returns.
 */

const MiB = 1024 * 1024;
const planId = z.string().min(1).max(256);
export const HostStorageRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.storage") }),
  z.object({
    type: z.literal("host.storage.preview"),
    /** Every settled worktree, as the web's "Delete all settled worktrees". */
    worktrees: z.boolean(),
    forceItems: z.array(planId).max(256),
  }),
  z.object({ type: z.literal("host.storage.apply"), planId }),
  z.object({ type: z.literal("host.storage.compact"), abandon: planId.optional() }),
  z.object({
    type: z.literal("host.storage.set"),
    setting: z.discriminatedUnion("key", [
      z.object({ key: z.literal("retentionDays"), days: z.number() }),
      z.object({ key: z.literal("logMegabytes"), megabytes: z.number() }),
      z.object({ key: z.literal("worktreeDays"), days: z.number().nullable() }),
      z.object({ key: z.literal("backupWorktrees"), on: z.boolean() }),
      z.object({ key: z.literal("scheduledCleanup"), on: z.boolean() }),
      z.object({ key: z.literal("kind"), kind: StorageKind, days: z.number().nullable() }),
    ]),
  }),
]);
export type HostStorageRequest = z.infer<typeof HostStorageRequest>;

export interface StorageUsageView {
  rows: { kind: string; title: string; detail: string; size: string }[];
  database: { size: string; detail: string };
  /** "Measured in a bounded batch; refresh for more." when the host stopped early. */
  partial: string | null;
  /** One line for every failed worktree backup, then up to three paths. */
  backups: { line: string; paths: string[] } | null;
}
export interface StorageSettingsView {
  /** The host data window in days, and the variable pinning it, if any. */
  retentionDays: { value: number; pinnedBy: string | null };
  logMegabytes: { value: number; pinnedBy: string | null };
  worktreeDays: number | null;
  backupWorktrees: boolean;
  scheduledCleanup: boolean;
  kinds: { kind: StorageKind; title: string; days: number | null; note: string | null }[];
}
export interface StoragePlanItemView {
  id: string;
  label: string;
  size: string;
  removes: boolean;
  /** "Remove · Old archived thread" */
  line: string;
  /** What else goes with it, when more than the item itself. */
  also: string | null;
  /** May be included despite uncommitted or unpushed work. */
  forceable: boolean;
  forced: boolean;
  /** After a removal ran: "Removed", "Kept: …", "Cleanup pending. Resume to retry." */
  outcome: string | null;
}
export interface StoragePlanView {
  id: string;
  title: string;
  summary: string;
  items: StoragePlanItemView[];
  /** The red action's words, or null when nothing can be removed. */
  action: string | null;
  confirm: { title: string; message: string; button: string } | null;
  /** After a removal: what happened, in one line. */
  outcome: string | null;
}

export function usageView(usage: StorageUsage): StorageUsageView {
  const failed = usage.backups.filter((backup) => backup.state === "failed");
  return {
    rows: usage.categories.map((category) => ({
      kind: category.kind,
      title: storageLabels[category.kind],
      detail: itemCount(category.items),
      size: storageBytes(category.bytes),
    })),
    database: {
      size: storageBytes(usage.databaseBytes),
      detail: `${storageBytes(usage.reclaimableDatabaseBytes)} can be reclaimed by compacting.`,
    },
    partial: usage.complete ? null : "Measured in a bounded batch; refresh for more.",
    backups: failed.length
      ? {
          line:
            failed.length === 1
              ? "Backup failed for 1 worktree. It was kept."
              : `Backup failed for ${failed.length} worktrees. They were kept.`,
          paths: failed
            .slice(0, 3)
            .map((backup) => `${backup.path}${backup.error ? ` · ${backup.error}` : ""}`),
        }
      : null,
  };
}

const forceableReasons = new Set(["uncommitted", "unpushed"]);

/** A cleanup plan as the phone shows it, with an apply's outcome once one ran. */
export function planView(plan: StoragePlan, applied?: StorageApply): StoragePlanView {
  const remove = plan.items.filter((item) => item.disposition === "remove");
  const kept = plan.items.length - remove.length;
  const finished = applied?.state === "complete" || applied?.state === "stale";
  const worktrees = plan.retention.worktreeMode === "all_settled";
  const counts = new Map<string, number>();
  for (const item of remove)
    counts.set(storageLabels[item.kind], (counts.get(storageLabels[item.kind]) ?? 0) + 1);
  const goes = [...counts].map(([label, count]) => `${label}: ${count}`);
  return {
    id: plan.id,
    title: worktrees ? "Worktree deletion preview" : "Cleanup preview",
    summary: plan.items.length
      ? `${itemCount(remove.length)} to remove · ${storageBytes(plan.bytes)} of data. ${kept} protected.${plan.complete ? "" : " This is a bounded batch. Preview again after cleanup to find more data."}`
      : "Nothing to clean up. No data was found in these storage categories.",
    items: plan.items.map((item) => {
      const result = applied?.items.find((entry) => entry.id === item.id);
      return {
        id: item.id,
        label: item.label,
        size: storageBytes(item.bytes),
        removes: item.disposition === "remove",
        line: [
          item.disposition === "remove" ? "Remove" : "Keep",
          item.reasons.map((reason) => storageReasons[reason]).join("; "),
          ...(item.forced ? ["Forced for this item"] : []),
          ...(item.removeBranch ? [`Also remove branch ${item.branch ?? ""}`.trim()] : []),
        ].join(" · "),
        also: item.effects.includes("browser_data")
          ? "Also clears this thread's attachment references and browser data."
          : null,
        forceable:
          item.kind === "worktrees" &&
          item.disposition === "protect" &&
          item.reasons.every((reason) => forceableReasons.has(reason)),
        forced: item.forced,
        outcome: !result
          ? null
          : result.state === "removed"
            ? "Removed"
            : result.state === "protected"
              ? `Kept: ${storageReasons[result.reason ?? "changed"]}`
              : "Cleanup pending. Resume to retry.",
      };
    }),
    action:
      !remove.length || finished
        ? null
        : applied?.state === "pending"
          ? "Resume cleanup"
          : `Remove ${itemCount(remove.length)}`,
    confirm:
      !remove.length || finished
        ? null
        : {
            title: `Remove ${itemCount(remove.length)}?`,
            message: `${goes.join(", ")}, ${storageBytes(plan.bytes)} in all, will be permanently removed. ace checks the plan again and keeps anything that has changed or is protected.`,
            button: "Remove items",
          },
    outcome:
      applied?.state === "stale"
        ? "This plan changed. Preview cleanup again before removing data."
        : applied?.state === "complete"
          ? "Cleanup finished. Items that became protected were kept."
          : null,
  };
}

export function compactionLine(result: StorageCompaction): string {
  if (result.incrementalUnavailable)
    return "This database was created before compaction was available and can't shrink in place.";
  if (result.state === "complete")
    return `Compacted from ${storageBytes(result.databaseBytesBefore)} to ${storageBytes(result.databaseBytes)}.`;
  return result.state === "pending"
    ? "Compaction paused. Resume to continue."
    : "Compaction stopped.";
}

/** The storage page of one machine's runtime; keeps the plan it showed so a removal can follow. */
export class HostStorage {
  #owner: ClientCore;
  #plans = new Map<string, StoragePlan>();
  constructor(owner: ClientCore) {
    this.#owner = owner;
  }
  async answer(request: HostStorageRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.type) {
      case "host.storage":
        return this.#page(signal);
      case "host.storage.preview": {
        const plan = await this.#storage(
          request.worktrees
            ? {
                op: "cleanup.plan",
                kinds: ["worktrees"],
                retention: StorageRetention.parse({ worktreeMode: "all_settled" }),
                forceItems: request.forceItems,
              }
            : { op: "cleanup.plan", forceItems: request.forceItems },
          signal,
        );
        if (plan.kind !== "plan") throw unexpected();
        this.#plans.clear();
        this.#plans.set(plan.plan.id, plan.plan);
        return { type: "host.storage.plan", plan: planView(plan.plan) };
      }
      case "host.storage.apply": {
        const plan = this.#plans.get(request.planId);
        if (!plan) throw new HostProblem("This preview expired. Preview cleanup again.");
        const result = await this.#storage(
          { op: "cleanup.apply", planId: plan.id, revision: plan.revision },
          signal,
        );
        if (result.kind !== "apply") throw unexpected();
        return { type: "host.storage.plan", plan: planView(plan, result.apply) };
      }
      case "host.storage.compact": {
        const result = await this.#storage(
          request.abandon
            ? { op: "cleanup.compactAbandon", compactionId: request.abandon }
            : { op: "cleanup.compact" },
          signal,
        );
        if (result.kind !== "compaction") throw unexpected();
        const compaction = result.compaction;
        return {
          type: "host.storage.compaction",
          line: compactionLine(compaction),
          pendingId: compaction.state === "pending" ? compaction.id : null,
        };
      }
      case "host.storage.set":
        await this.#set(request.setting, signal);
        return this.#page(signal);
    }
  }
  async #page(signal: AbortSignal) {
    const [usage, settings] = await Promise.allSettled([
      this.#storage({ op: "storage.usage" }, signal),
      this.#settings(signal),
    ]);
    if (settings.status === "rejected") throw settings.reason;
    const measured =
      usage.status === "fulfilled" && usage.value.kind === "usage" ? usage.value.usage : undefined;
    return {
      type: "host.storage",
      usage: measured ? usageView(measured) : null,
      usageProblem: measured ? null : "Couldn't measure storage. Pull to try again.",
      settings: settings.value,
    };
  }
  async #settings(signal: AbortSignal): Promise<StorageSettingsView> {
    const keys = [
      "storage.retentionDays",
      "logs.maxBytes",
      "storage.worktreeRetentionDays",
      "storage.backupWorktrees",
      "storage.scheduledCleanup",
      "storage.retention",
    ] as const;
    const read = await Promise.all(
      keys.map((key) =>
        this.#owner.request(
          { type: "settings.get", key, scope: {}, requestId: host.uuid() },
          { signal, timeoutMs: 15_000 },
        ),
      ),
    );
    const entry = (index: number) => {
      const reply = read[index];
      const found = reply?.ok ? reply.entries.find((item) => item.key === keys[index]) : undefined;
      if (!found) throw new HostProblem("This machine didn't share its storage settings.");
      return found;
    };
    const days = entry(0);
    const logs = entry(1);
    const retention = StorageRetention.parse(entry(5).value ?? {});
    return {
      retentionDays: {
        value: RetentionDays.catch(90).parse(days.value),
        pinnedBy: days.provenance === "environment" ? "ACE_RETENTION_DAYS" : null,
      },
      logMegabytes: {
        value: Math.round(LogMaxBytes.catch(64 * MiB).parse(logs.value) / MiB),
        pinnedBy: logs.provenance === "environment" ? "ACE_LOG_MAX_BYTES" : null,
      },
      worktreeDays: RetentionDays.nullable().catch(null).parse(entry(2).value),
      backupWorktrees: entry(3).value === true,
      scheduledCleanup: entry(4).value === true,
      kinds: StorageKind.options.map((kind) => ({
        kind,
        title: storageLabels[kind],
        days: retention[kind],
        note: kind === "worktrees" ? "Archived threads only." : null,
      })),
    };
  }
  async #set(
    setting: Extract<HostStorageRequest, { type: "host.storage.set" }>["setting"],
    signal: AbortSignal,
  ): Promise<void> {
    const [key, value] = await this.#setting(setting, signal);
    const reply = await this.#owner.request(
      { type: "settings.set", key, value, layer: { kind: "global" }, requestId: host.uuid() },
      { signal, timeoutMs: 15_000 },
    );
    if (!reply.ok)
      throw new HostProblem(
        reply.diagnostics[0]?.message ?? "Couldn't save that. This machine may need admin access.",
      );
  }
  async #setting(
    setting: Extract<HostStorageRequest, { type: "host.storage.set" }>["setting"],
    signal: AbortSignal,
  ): Promise<[string, unknown]> {
    switch (setting.key) {
      case "retentionDays": {
        const days = RetentionDays.safeParse(setting.days);
        if (!days.success) throw new HostProblem("Keep data for 1 to 3650 days.");
        return ["storage.retentionDays", days.data];
      }
      case "logMegabytes": {
        const bytes = LogMaxBytes.safeParse(Math.round(setting.megabytes) * MiB);
        if (!bytes.success) throw new HostProblem("Log limit is 1 to 65536 MB.");
        return ["logs.maxBytes", bytes.data];
      }
      case "worktreeDays": {
        if (setting.days === null) return ["storage.worktreeRetentionDays", null];
        const days = RetentionDays.safeParse(setting.days);
        if (!days.success) throw new HostProblem("Keep settled worktrees for 1 to 3650 days.");
        return ["storage.worktreeRetentionDays", days.data];
      }
      case "backupWorktrees":
        return ["storage.backupWorktrees", setting.on];
      case "scheduledCleanup":
        return ["storage.scheduledCleanup", setting.on];
      case "kind": {
        const reply = await this.#owner.request(
          { type: "settings.get", key: "storage.retention", scope: {}, requestId: host.uuid() },
          { signal, timeoutMs: 15_000 },
        );
        const current = reply.entries.find((entry) => entry.key === "storage.retention")?.value;
        if (!reply.ok || current === undefined)
          throw new HostProblem("This machine didn't share its storage settings.");
        // Only the one kind changes; idle threads and the worktree mode stay as they were.
        const parsed = StorageRetention.safeParse({
          ...StorageRetention.parse(current),
          [setting.kind]: setting.days,
        });
        if (!parsed.success) throw new HostProblem("Keep each kind for 1 to 36500 days.");
        return ["storage.retention", parsed.data];
      }
    }
  }
  async #storage(operation: StorageRequest["operation"], signal: AbortSignal) {
    const reply = await this.#owner.request(
      { type: "storage.request", operation, requestId: host.uuid() },
      { signal, timeoutMs: 60_000 },
    );
    if (reply.result.kind === "error") throw new HostProblem(reply.result.message);
    return reply.result;
  }
}

const unexpected = () => new HostProblem("This machine answered unexpectedly.");
