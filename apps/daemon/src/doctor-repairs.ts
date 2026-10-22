import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@ace/diagnostics";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";

/** Folder repair allowlist. Database reclamation belongs to the storage owner. */
const targets = [
  { id: "home.permissions", child: "", label: "ace data folder" },
  { id: "logs.directory", child: "logs", label: "Log folder" },
] as const;
export function localDoctorChecks(dataDir: string, uid: number | undefined): Check[] {
  return targets.map((target) => ({
    id: target.id,
    fix: "Run ace doctor --fix to repair owner permissions or create the missing folder.",
    async run() {
      // Inspect the parent too: never follow ACE_HOME through a symlink to inspect its logs.
      const root = await inspect(dataDir, uid);
      const state =
        target.child && root === "ok" ? await inspect(join(dataDir, target.child), uid) : root;
      return {
        status: state === "ok" ? "ok" : state === "missing" ? "warn" : "fail",
        message: `${target.label}: ${state}`,
        fix: "Run ace doctor --fix. Links, non-directories and folders owned by another user require manual repair.",
      };
    },
  }));
}
async function inspect(path: string, uid: number | undefined) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "not a regular directory";
    if (uid !== undefined && stat.uid !== uid) return "owned by another user";
    if (uid !== undefined && (stat.mode & 0o777) !== 0o700) return "permissions need repair";
    return "ok";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    return "unreadable";
  }
}
export async function repairDoctor(
  dataDir: string,
  report: DiagnosticReport,
  uid: number | undefined,
): Promise<DiagnosticRepair[]> {
  const repairs: DiagnosticRepair[] = [];
  for (const target of targets) {
    if (!report.checks.some((check) => check.id === target.id && check.status !== "ok")) continue;
    try {
      // Opening each directory without following its final component prevents a swapped link
      // from redirecting chmod. Refuse an unsafe data folder before inspecting its child.
      if (target.child) {
        const root = await openDirectory(dataDir, uid);
        try {
          const anchored = join(dataDir, "logs");
          await fixDirectory(anchored, uid);
        } finally {
          await root.close();
        }
      } else await fixDirectory(dataDir, uid);
      repairs.push({
        id: target.id,
        status: "fixed",
        message: `${target.label}: owner access restored`,
      });
    } catch {
      repairs.push({
        id: target.id,
        status: "failed",
        message: `${target.label}: automatic repair refused or failed; check its type, ownership and parent permissions.`,
      });
    }
  }
  return repairs;
}
async function openDirectory(path: string, uid: number | undefined) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid))
      throw new Error("Unsafe repair target");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function fixDirectory(path: string, uid: number | undefined) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const handle = await openDirectory(path, uid);
  try {
    if (uid !== undefined) await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}
