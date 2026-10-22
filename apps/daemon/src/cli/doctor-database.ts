import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import { connectCli, hostConnection } from "./connection.ts";
import { option, type Args } from "./args.ts";
import { storageRequest } from "./retention-request.ts";

/** The running storage owner supplies its write fence and resumable compaction journal. */
export async function repairDoctorDatabase(
  home: string,
  args: Args,
  report: DiagnosticReport,
): Promise<DiagnosticRepair[]> {
  const needsReclaim = report.checks.some(
    (check) => ["sqlite.space", "sqlite.wal"].includes(check.id) && check.status === "warn",
  );
  if (
    !needsReclaim ||
    !report.checks.some((check) => check.id === "sqlite" && check.status === "ok")
  )
    return [];
  try {
    hostConnection(home);
  } catch {
    return [
      {
        id: "sqlite.space",
        status: "skipped",
        message:
          "Database reclamation needs its local daemon. Start ace and rerun ace doctor --fix. No offline database writes were attempted.",
      },
    ];
  }
  try {
    const session = await connectCli(home, {
      ...args,
      flags: { ...args.flags, remote: "local", timeout: option(args, "timeout") ?? "30s" },
    });
    try {
      const result = await storageRequest(
        session.client,
        { op: "cleanup.compact" },
        session.signal,
      );
      if (result.kind !== "compaction") throw new Error("Missing compaction result");
      const value = result.compaction;
      const legacy = value.incrementalUnavailable && value.reclaimableDatabaseBytes >= 1024 * 1024;
      const detail = `Databases: ${size(value.databaseBytesBefore)} → ${size(value.databaseBytes)}; ${size(value.reclaimableDatabaseBytes)} still reusable.`;
      return [
        {
          id: "sqlite.space",
          status: value.state === "complete" && value.checkpointed && !legacy ? "fixed" : "skipped",
          message: legacy
            ? `${detail} Legacy auto_vacuum=none cannot be safely shrunk here; a rowid-preserving migration is required. No full VACUUM was run.`
            : value.state !== "complete" || !value.checkpointed
              ? `${detail} Reclamation is pending or a reader kept the WAL open. Rerun ace doctor --fix to resume.`
              : detail,
        },
      ];
    } finally {
      await session.close();
    }
  } catch {
    return [
      {
        id: "sqlite.space",
        status: "failed",
        message:
          "Database reclamation could not be confirmed. Keep the database and WAL files; ensure the local daemon is available and rerun ace doctor --fix to inspect or resume.",
      },
    ];
  }
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
