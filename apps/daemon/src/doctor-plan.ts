import type { DiagnosticReport } from "@ace/protocol";

export type DoctorRepairId = "folders" | "database";
export type PlannedRepair = {
  id: DoctorRepairId;
  title: string;
  detail: string;
  /** Chosen by default in the picker and run by `--fix`. */
  recommended: boolean;
  /** Why it can't run right now; such repairs are listed but never run. */
  blocked?: string;
};

const FOLDER_CHECKS = new Set(["home.permissions", "logs.directory"]);
const SPACE_CHECKS = new Set(["sqlite.space", "sqlite.wal"]);

/** Which repairs this report calls for. Pure: the caller supplies the daemon's state. */
export function planDoctorRepairs(
  report: DiagnosticReport,
  daemon: "running" | "stopped",
): PlannedRepair[] {
  const open = report.checks.filter((check) => check.status !== "ok");
  const plan: PlannedRepair[] = [];
  const folders = open.filter((check) => FOLDER_CHECKS.has(check.id));
  if (folders.length)
    plan.push({
      id: "folders",
      title: "Fix ace folder access",
      detail: `${folders.map((check) => check.message).join("; ")}. Creates missing folders and makes them private to you. Links and folders owned by someone else are left alone.`,
      recommended: true,
    });
  const space = open.filter((check) => SPACE_CHECKS.has(check.id) && check.status === "warn");
  const healthy = report.checks.some((check) => check.id === "sqlite" && check.status === "ok");
  if (space.length && healthy)
    plan.push({
      id: "database",
      title: "Reclaim database space",
      detail: `${space.map((check) => check.message).join("; ")}. The running daemon compacts its databases in small steps; writes pause briefly and no rows are deleted.`,
      recommended: daemon === "running",
      ...(daemon === "running"
        ? {}
        : {
            blocked:
              "Start ace, then run ace doctor again. No offline database writes were attempted.",
          }),
    });
  return plan;
}

/** What `--fix` runs: recommended and not blocked. */
export function recommendedRepairs(plan: readonly PlannedRepair[]): DoctorRepairId[] {
  return plan.filter((repair) => repair.recommended && !repair.blocked).map((repair) => repair.id);
}
