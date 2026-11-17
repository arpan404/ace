import type { StorageApply, StorageCompaction, StoragePlan, StorageUsage } from "@ace/protocol";

/** Words for `ace storage` (ADR 0176 §3). Pure: values → lines. */

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function usageLines(usage: StorageUsage): string[] {
  const total = usage.categories.reduce((sum, category) => sum + category.bytes, 0);
  const lines = usage.categories.map(
    (category) =>
      `${category.kind.padEnd(12)} ${formatBytes(category.bytes).padStart(9)}  ${plural(category.items, "item")}`,
  );
  lines.push(`${"database".padEnd(12)} ${formatBytes(usage.databaseBytes).padStart(9)}`);
  lines.push(`${"total".padEnd(12)} ${formatBytes(total + usage.databaseBytes).padStart(9)}`);
  if (usage.reclaimableDatabaseBytes > 0)
    lines.push(
      "",
      `${formatBytes(usage.reclaimableDatabaseBytes)} of the database is free space; reclaim it with ace storage compact.`,
    );
  for (const backup of usage.backups.filter((item) => item.state === "failed"))
    lines.push(
      `✕ Worktree backup failed: ${backup.path}${backup.error ? ` (${backup.error})` : ""}`,
    );
  if (!usage.complete) lines.push("Still measuring; some sizes are partial.");
  lines.push("", "Plan a cleanup with ace storage clean --dry-run.");
  return lines;
}

export function planLines(plan: StoragePlan): string[] {
  const remove = plan.items.filter((item) => item.disposition === "remove");
  const keep = plan.items.filter((item) => item.disposition === "protect");
  const lines = [`Plan ${plan.id} (revision ${plan.revision})`];
  lines.push(`Remove ${plural(remove.length, "item")}, ${formatBytes(plan.bytes)}:`);
  for (const item of remove)
    lines.push(`  ${item.kind.padEnd(11)} ${item.label}  ${formatBytes(item.bytes)}`);
  if (keep.length) lines.push(`Keep ${plural(keep.length, "item")}:`);
  for (const item of keep)
    lines.push(
      `  ${item.kind.padEnd(11)} ${item.label}  ${item.reasons.join(", ").replaceAll("_", " ")}`,
    );
  if (!plan.complete)
    lines.push("Inventory is incomplete; run the cleanup again after this batch.");
  return lines;
}

/** A plan from `storage plan` or `clean --dry-run`, with the command that applies it. */
export function reviewLines(plan: StoragePlan): string[] {
  const removable = plan.items.some((item) => item.disposition === "remove");
  return [
    ...planLines(plan),
    removable
      ? `Apply it with ace storage apply ${plan.id} --revision ${plan.revision}`
      : "Nothing to remove.",
  ];
}

/** The confirmation `storage clean` asks before it removes anything. */
export function confirmQuestion(plan: StoragePlan): string {
  const count = plan.items.filter((item) => item.disposition === "remove").length;
  return `Remove ${plural(count, "item")} (${formatBytes(plan.bytes)})?`;
}

export function receiptLine(receipt: StorageApply & { revision?: string }): string {
  const count = (state: string) => receipt.items.filter((item) => item.state === state).length;
  const where = `plan ${receipt.planId}${receipt.revision ? `, revision ${receipt.revision}` : ""}`;
  if (receipt.state === "stale")
    return `✕ The plan changed since it was reviewed, so nothing was removed (${where}). Plan again with ace storage plan.`;
  return `Cleanup ${receipt.state}: ${count("removed")} removed, ${count("protected")} kept, ${count("pending")} pending (${where}).`;
}

export function compactionLines(compaction: StorageCompaction): string[] {
  if (compaction.incrementalUnavailable)
    return ["This database predates in-place compaction, so nothing was changed."];
  const saved = Math.max(0, compaction.databaseBytesBefore - compaction.databaseBytes);
  const lines = [
    compaction.state === "complete"
      ? `Compacted the database: ${formatBytes(compaction.databaseBytesBefore)} to ${formatBytes(compaction.databaseBytes)}, ${formatBytes(saved)} freed.`
      : compaction.state === "abandoned"
        ? `Compaction ${compaction.id} was given up.`
        : `Compaction ${compaction.id} is still running.`,
  ];
  if (!compaction.checkpointed)
    lines.push("A reader kept the log from being truncated; run it again later.");
  return lines;
}
