import { z } from "zod";
import type { DiscoveryResult, Provider } from "@ace/provider-kit/discovery";
export const CheckResult = z.object({
  id: z.string().max(128),
  status: z.enum(["ok", "warn", "fail"]),
  message: z.string().max(2048),
  fix: z.string().max(2048),
});
export type CheckResult = z.infer<typeof CheckResult>;
export const DoctorReport = z.object({ at: z.number(), checks: z.array(CheckResult).max(64) });
export type DoctorReport = z.infer<typeof DoctorReport>;
export type Verdict = Omit<CheckResult, "id">;
export interface Check {
  id: string;
  fix: string;
  run(signal: AbortSignal): Promise<Verdict>;
}
export interface DoctorProbes {
  node(signal: AbortSignal): Promise<string>;
  provider(provider: Provider, signal: AbortSignal): Promise<DiscoveryResult>;
  antigravity?(signal: AbortSignal): Promise<DiscoveryResult>;
  git(signal: AbortSignal): Promise<string | undefined>;
  pty(signal: AbortSignal): Promise<boolean>;
  chromium(signal: AbortSignal): Promise<string | undefined>;
  disk(signal: AbortSignal): Promise<{ writable: boolean; freeBytes: number }>;
  integrity(signal: AbortSignal): Promise<"ok" | "corrupt" | "missing" | "unavailable">;
  port(signal: AbortSignal): Promise<boolean>;
}
const verdict = (status: Verdict["status"], message: string, fix: string): Verdict => ({
  status,
  message,
  fix,
});
export function nodeVerdict(version: string): Verdict {
  const major = /^v?(\d+)\./.exec(version)?.[1];
  return verdict(
    major && Number(major) >= 24 ? "ok" : "fail",
    `Node ${version}`,
    "Install Node 24 or newer and restart ace.",
  );
}
export function providerVerdict(provider: string, result: DiscoveryResult): Verdict {
  const fix = result.installed
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
      fix: "Install Node 24+.",
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
      fix: "Install agy or open it interactively to verify your Google account login.",
      run: async (signal) =>
        probes.antigravity
          ? providerVerdict("antigravity", await probes.antigravity(signal))
          : verdict(
              "warn",
              "Antigravity login status is unknown",
              "Open agy interactively to verify your Google account login.",
            ),
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
      fix: "Install Chrome/Chromium or set ACE_CHROMIUM to its executable.",
      run: async (signal) => {
        const browser = await probes.chromium(signal);
        return verdict(
          browser ? "ok" : "warn",
          browser ? "Chromium executable found" : "Chromium executable not found",
          "Install Chrome/Chromium or set ACE_CHROMIUM to its executable.",
        );
      },
    },
    {
      id: "disk",
      fix: "Check ACE_HOME permissions and free space.",
      run: async (signal) => diskVerdict(await probes.disk(signal)),
    },
    {
      id: "sqlite",
      fix: "Stop ace and preserve the database before restoring a backup.",
      run: async (signal) => integrityVerdict(await probes.integrity(signal)),
    },
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
      const controller = new AbortController();
      let cancel = noop;
      try {
        const timeout = new Promise<Verdict>((resolve) => {
          cancel = schedule(() => {
            controller.abort();
            resolve(verdict("fail", "Check timed out", check.fix));
          }, timeoutMs);
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
