import { unlink } from "node:fs/promises";
import type { Check } from "@ace/diagnostics";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import type { PlannedRepair } from "../doctor-plan.ts";
import type { DoctorContext } from "./feature.ts";
import { findBackups, readBackup, updateInProgress, type Backup } from "./storage-backups.ts";
import { clip, formatBytes, plural } from "./format.ts";

export const BACKUPS_REPAIR = "storage.backups";
const FIX =
  "Delete them from ace doctor once you're sure you won't roll back, or keep them if you might.";

const total = (backups: readonly Backup[]) => backups.reduce((sum, b) => sum + b.bytes, 0);
const describe = (backup: Backup) => `${backup.name} ${formatBytes(backup.bytes)}`;

/** Leftover pre-upgrade copies of the databases, and whether each can go. */
export function backupsCheck(context: DoctorContext): Check {
  return {
    id: "storage.backups",
    fix: FIX,
    async run() {
      const backups = findBackups(context.config.dataDir, context.now());
      if (!backups.length) return { status: "ok", message: "No old database backups", fix: FIX };
      const removable = backups.filter((backup) => !backup.kept);
      const kept = backups.filter((backup) => backup.kept);
      const parts = [
        `${plural(backups.length, "old database backup")} ${backups.length === 1 ? "uses" : "use"} ${formatBytes(total(backups))}: ${backups.map(describe).join(", ")}.`,
        removable.length
          ? `${removable.length === 1 ? (backups.length === 1 ? "It is" : "1 is") : removable.length === backups.length ? "All are" : `${removable.length} are`} from before an upgrade the current database has finished; ace never reads them again.`
          : undefined,
        ...kept.map((backup) => `${backup.name} stays: ${backup.kept}.`),
      ];
      return {
        status: "warn",
        message: clip(parts.filter((part) => part !== undefined).join(" ")),
        fix: FIX,
      };
    },
  };
}

/** Why deleting backups must wait, or undefined when nothing stands in the way. */
function blocker(report: DiagnosticReport, dataDir: string): string | undefined {
  if (updateInProgress(dataDir))
    return "An ace update is migrating data right now. Let it finish, then run ace doctor again.";
  const integrity = report.checks.find((check) => check.id === "sqlite");
  if (integrity?.status !== "ok")
    return "The database integrity check didn't pass or didn't finish, so the backups stay: one may be the good copy.";
  return undefined;
}

/**
 * Plans deleting the backups the current databases have moved past, and remembers exactly
 * which files it planned for this context. Never recommended: deleting gives up rolling back.
 */
export function backupRepairs() {
  const planned = new WeakMap<DoctorContext, readonly string[]>();
  return {
    plan(report: DiagnosticReport, context: DoctorContext): PlannedRepair[] {
      const dataDir = context.config.dataDir;
      const removable = findBackups(dataDir, context.now()).filter((backup) => !backup.kept);
      planned.set(
        context,
        removable.map((backup) => backup.name),
      );
      if (!removable.length) return [];
      const blocked = blocker(report, dataDir);
      return [
        {
          id: BACKUPS_REPAIR,
          title: `Delete old database backups (${formatBytes(total(removable))})`,
          detail: clip(
            `Deletes ${removable.map((backup) => backup.name).join(", ")}. The current databases have moved past them and ace never reads them again, but once they're gone you can't roll back to the data as it was before those upgrades.`,
          ),
          recommended: false,
          ...(blocked ? { blocked } : {}),
        },
      ];
    },
    /** Deletes only the files planned for this context, each re-checked as a removable backup first. */
    async apply(report: DiagnosticReport, context: DoctorContext): Promise<DiagnosticRepair[]> {
      const dataDir = context.config.dataDir;
      const names = planned.get(context) ?? [];
      const blocked = blocker(report, dataDir);
      if (blocked || !names.length)
        return [
          {
            id: BACKUPS_REPAIR,
            status: "skipped",
            message: blocked ?? "No old database backups were planned for deletion.",
          },
        ];
      const deleted: Backup[] = [];
      const left: string[] = [];
      for (const name of names) {
        const backup = readBackup(dataDir, name, context.now());
        if (!backup || backup.kept) {
          left.push(`${name} (${backup?.kept ?? "no longer a backup file"})`);
          continue;
        }
        await unlink(backup.path);
        deleted.push(backup);
      }
      const message = [
        deleted.length
          ? `Deleted ${plural(deleted.length, "backup")} (${formatBytes(total(deleted))}): ${deleted.map((b) => b.name).join(", ")}.`
          : "Deleted nothing.",
        left.length ? `Kept ${left.join(", ")}.` : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      return [
        {
          id: BACKUPS_REPAIR,
          status: deleted.length ? "fixed" : "skipped",
          message: clip(message),
        },
      ];
    },
  };
}
