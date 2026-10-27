import { z } from "zod";
import type { SqliteSpace } from "./sqlite-space.ts";
import type { DiscoveryResult, Provider } from "@ace/provider-kit/discovery";
export { DiagnosticReport as DoctorReport } from "@ace/protocol";
import {
  DiagnosticCheck as CheckResult,
  type DiagnosticReport as DoctorReport,
} from "@ace/protocol";
export type CheckResult = z.infer<typeof CheckResult>;
export type Verdict = Omit<CheckResult, "id">;
export interface Check {
  id: string;
  fix: string;
  /** Overrides the runner's limit for checks whose cost grows with data, like integrity. */
  timeoutMs?: number;
  run(signal: AbortSignal): Promise<Verdict>;
}

const GIB = 1024 ** 3;
/**
 * Time allowed for a full SQLite integrity check. Measured at about 1.7 s per GiB with a
 * warm cache on an Apple SSD; the budget leaves roughly ten times that for cold caches and
 * slower disks, and a hard cap so a hung probe still ends.
 */
export function integrityBudgetMs(databaseBytes: number): number {
  const bytes = Number.isFinite(databaseBytes) && databaseBytes > 0 ? databaseBytes : 0;
  return Math.min(MAX_INTEGRITY_BUDGET_MS, 30_000 + Math.ceil((bytes / GIB) * 20_000));
}
export const MAX_INTEGRITY_BUDGET_MS = 15 * 60_000;
const CHROMIUM_BUDGET_MS = 25_000;
export interface DoctorProbes {
  node(signal: AbortSignal): Promise<string>;
  provider(provider: Provider, signal: AbortSignal): Promise<DiscoveryResult>;
  antigravity?(signal: AbortSignal): Promise<DiscoveryResult>;
  git(signal: AbortSignal): Promise<string | undefined>;
  pty(signal: AbortSignal): Promise<boolean>;
  /** ace's browser engine: whether the Chromium ace runs starts on this machine. */
  chromium(signal: AbortSignal): Promise<Verdict>;
  disk(signal: AbortSignal): Promise<{ writable: boolean; freeBytes: number }>;
  integrity(signal: AbortSignal): Promise<"ok" | "corrupt" | "missing" | "unavailable">;
  /** Size of the main database plus its WAL, read when the probes are created. */
  databaseBytes?: number;
  databaseSpace?(signal: AbortSignal): Promise<SqliteSpace | null>;
  port(signal: AbortSignal): Promise<boolean>;
}
export function databaseSpaceVerdict(space: SqliteSpace | null): Verdict {
  if (!space) return verdict("ok", "No SQLite database yet; no space to reclaim", "");
  const free = (space.reclaimableBytes / 1024 / 1024).toFixed(2);
  const allocated = (space.pageBytes / 1024 / 1024).toFixed(2);
  return verdict(
    space.reclaimableBytes >= 1024 * 1024 ? "warn" : "ok",
    `SQLite: ${allocated} MiB allocated, ${free} MiB reusable; auto_vacuum=${space.autoVacuum}`,
    space.autoVacuum === 0
      ? "Legacy database: free pages are reused, but shrinking requires a rowid-preserving migration. Do not run plain VACUUM."
      : "Run ace doctor --fix with the local daemon running to reclaim deleted-row space.",
  );
}
export function walSpaceVerdict(space: SqliteSpace | null): Verdict {
  return verdict(
    space && space.walBytes >= 32 * 1024 * 1024 ? "warn" : "ok",
    `SQLite WAL: ${((space?.walBytes ?? 0) / 1024 / 1024).toFixed(2)} MiB`,
    "Run ace doctor --fix with the local daemon running. A reader can delay checkpointing; retry after it finishes.",
  );
}
const verdict = (status: Verdict["status"], message: string, fix: string): Verdict => ({
  status,
  message,
  fix,
});
const antigravityFix =
  "Install Antigravity's official ACP server in Settings > Providers, then use its own ACP authentication to sign in.";
export function nodeVerdict(version: string): Verdict {
  const major = /^v?(\d+)\./.exec(version)?.[1];
  return verdict(
    major && Number(major) >= 26 ? "ok" : "fail",
    `Node ${version}`,
    "Install Node 26 or newer and restart ace.",
  );
}
export function providerVerdict(provider: string, result: DiscoveryResult): Verdict {
  const fix =
    provider === "antigravity"
      ? antigravityFix
      : result.installed
        ? `Run ${result.loginHint}; update the CLI if its status probe fails.`
        : `Install ${provider}'s CLI and add it to PATH.`;
  if (!result.installed) return verdict("warn", `${provider}: CLI not installed`, fix);
  const status =
    result.auth === "logged_out"
      ? "fail"
      : result.auth === "unknown" || !result.version || result.error
        ? "warn"
        : "ok";
  return verdict(
    status,
    `${provider}: ${result.version ?? "version unknown"}, ${result.auth}${result.error ? `; ${result.error}` : ""}`,
    fix,
  );
}
export function diskVerdict(disk: { writable: boolean; freeBytes: number }): Verdict {
  if (!disk.writable)
    return verdict(
      "fail",
      "Data directory is not readable and writable",
      "Restore owner read/write/search permissions on ACE_HOME.",
    );
  const status =
    disk.freeBytes < 64 * 1024 * 1024
      ? "fail"
      : disk.freeBytes < 1024 * 1024 * 1024
        ? "warn"
        : "ok";
  return verdict(
    status,
    `${Math.floor(disk.freeBytes / 1024 / 1024)} MiB free`,
    "Free disk space on the volume containing ACE_HOME.",
  );
}
export function integrityVerdict(value: "ok" | "corrupt" | "missing" | "unavailable"): Verdict {
  if (value === "unavailable")
    return verdict(
      "fail",
      "SQLite could not be read",
      "Check database permissions, lock contention and the Node SQLite installation before retrying.",
    );
  return verdict(
    value === "corrupt" ? "fail" : value === "missing" ? "warn" : "ok",
    `SQLite integrity: ${value}`,
    value === "missing"
      ? "Start ace to initialize a new database, or restore a backup if you expected existing data."
      : "Stop ace, preserve events.sqlite and its WAL, then restore a known-good backup. Do not delete the only copy.",
  );
}
export function createDoctorChecks(probes: DoctorProbes): Check[] {
  const checks: Check[] = [
    {
      id: "node",
      fix: "Install Node 26+.",
      run: async (signal) => nodeVerdict(await probes.node(signal)),
    },
    ...(["claude", "codex", "opencode", "cursor"] as const).map((provider) => ({
      id: `provider.${provider}`,
      fix: `Check ${provider}'s CLI installation and login.`,
      run: async (signal: AbortSignal) =>
        providerVerdict(provider, await probes.provider(provider, signal)),
    })),
    {
      id: "provider.antigravity",
      fix: antigravityFix,
      run: async (signal) =>
        probes.antigravity
          ? providerVerdict("antigravity", await probes.antigravity(signal))
          : verdict("warn", "Antigravity login status is unknown", antigravityFix),
    },
    {
      id: "git",
      fix: "Install git and add it to PATH.",
      run: async (signal) => {
        const version = await probes.git(signal);
        return verdict(
          version ? "ok" : "fail",
          version ?? "git not found",
          "Install git and add it to PATH.",
        );
      },
    },
    {
      id: "node-pty",
      fix: "Reinstall/rebuild node-pty for this Node or Electron ABI.",
      run: async (signal) => {
        const loadable = await probes.pty(signal);
        return verdict(
          loadable ? "ok" : "fail",
          loadable
            ? "node-pty loads for running ABI"
            : "node-pty is missing or cannot load for running ABI",
          "Reinstall/rebuild node-pty for this Node or Electron ABI.",
        );
      },
    },
    {
      id: "chromium",
      fix: "Check ace's browser: the daemon log has why it did not start, or set ACE_CHROMIUM_PATH to a working Chromium.",
      // A real Chrome start (version, then a headless launch, 10 s each at most).
      timeoutMs: CHROMIUM_BUDGET_MS,
      run: (signal) => probes.chromium(signal),
    },
    {
      id: "disk",
      fix: "Check ACE_HOME permissions and free space.",
      run: async (signal) => diskVerdict(await probes.disk(signal)),
    },
    {
      id: "sqlite",
      fix: "Stop ace and preserve the database before restoring a backup.",
      timeoutMs: integrityBudgetMs(probes.databaseBytes ?? 0),
      run: async (signal) => integrityVerdict(await probes.integrity(signal)),
    },
    ...(probes.databaseSpace
      ? [
          {
            id: "sqlite.space",
            fix: "Check database free pages and run ace doctor --fix.",
            run: async (signal: AbortSignal) =>
              databaseSpaceVerdict((await probes.databaseSpace?.(signal)) ?? null),
          },
          {
            id: "sqlite.wal",
            fix: "Check the SQLite WAL and run ace doctor --fix.",
            run: async (signal: AbortSignal) =>
              walSpaceVerdict((await probes.databaseSpace?.(signal)) ?? null),
          },
        ]
      : []),
    {
      id: "port",
      fix: "Stop the existing daemon or set ACE_PORT to an unused port.",
      run: async (signal) => {
        const available = await probes.port(signal);
        return verdict(
          available ? "ok" : "warn",
          available
            ? "Daemon loopback port is available"
            : "Daemon loopback port is already in use",
          "Stop the existing daemon or set ACE_PORT to an unused port.",
        );
      },
    },
  ];
  return checks;
}
export interface DoctorRunnerOptions {
  now: () => number;
  timeoutMs?: number;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}
const noop = () => {};
export async function runDoctor(
  checks: readonly Check[],
  options: DoctorRunnerOptions,
): Promise<DoctorReport> {
  if (checks.length > 64) throw new RangeError("Too many checks");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError("Invalid check timeout");
  const schedule =
    options.schedule ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const results = await Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      const limit = check.timeoutMs ?? timeoutMs;
      const controller = new AbortController();
      let cancel = noop;
      try {
        const timeout = new Promise<Verdict>((resolve) => {
          cancel = schedule(() => {
            controller.abort();
            // Not finishing in time says nothing about health; a slow check on a big
            // database must not read as corruption.
            resolve(
              verdict(
                "warn",
                `Didn't finish within ${Math.round(limit / 1000)} s`,
                `Run ace doctor again. If it never finishes: ${check.fix}`,
              ),
            );
          }, limit);
        });
        const result = await Promise.race([
          Promise.resolve().then(() => check.run(controller.signal)),
          timeout,
        ]);
        return CheckResult.parse({ id: check.id, ...result });
      } catch {
        return { id: check.id, status: "fail", message: "Probe failed", fix: check.fix };
      } finally {
        cancel();
        controller.abort();
      }
    }),
  );
  return { at: options.now(), checks: results };
}
export function formatDoctor(report: DoctorReport): string {
  return (
    report.checks
      .map(
        (check) =>
          `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}${check.status === "ok" ? "" : `\n     Fix: ${check.fix}`}`,
      )
      .join("\n") + "\n"
  );
}
