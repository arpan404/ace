import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { spadeBinaryName, spadeServicePlan, type SpadeServicePlan } from "./spade-plan.ts";
import { readOwnFile } from "./spade-registration.ts";
import { sidFromWhoami } from "./windows-user.ts";

/**
 * A fresh start (ADR 0081) renames the whole home aside, `releases/spade` and Spade's data with
 * it, so Spade's service must not be running across the rename: Windows refuses to move a
 * running `spade-server.exe`, and elsewhere Spade would keep running from the moved folder.
 * Synchronous, like the fresh start itself. Only a service ace registered for this home is
 * touched.
 */
export interface FreshStartSpade {
  /** Stops Spade if its service is registered for `root`; undefined when there is none. */
  pause(root: string): PausedSpade | undefined;
}
export interface PausedSpade {
  /** After the rename: brings Spade's program files over from `backup` and starts it again. */
  resume(backup: string): void;
}

export type SyncRunner = (
  file: string,
  args: readonly string[],
) => { code: number; stderr: string };

const systemRun: SyncRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stderr: result.stderr ?? "" };
};

/** Spade's pieces that are program, not data: they follow the home, `spade/` stays behind. */
export function carrySpadeProgram(plan: SpadeServicePlan, backup: string): void {
  const pieces = [
    join("releases", "spade"),
    // Windows keeps the task's launcher and ace's record of the task inside the home.
    ...(plan.platform === "win32"
      ? [relative(plan.home, plan.launcher.file), relative(plan.home, plan.file)]
      : []),
  ];
  for (const piece of pieces) {
    const from = join(backup, piece);
    const to = join(plan.home, piece);
    if (!present(from) || present(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function must(run: SyncRunner, file: string, args: readonly string[], ok = [0]): void {
  const result = run(file, args);
  if (!ok.includes(result.code))
    throw new Error(`${file} ${args[0] ?? ""} failed (${result.code}): ${result.stderr}`);
}

/** The service manager's stop and start for `plan`, synchronously. */
export function spadeServiceSwitch(plan: SpadeServicePlan, run: SyncRunner) {
  if (plan.platform === "darwin") {
    const gui = plan.domain.slice(0, plan.domain.lastIndexOf("/"));
    return {
      // KeepAlive restarts a killed job, so it is booted out; 3 and 113: not loaded.
      stop: () => must(run, "launchctl", ["bootout", plan.domain], [0, 3, 113]),
      start: () => must(run, "launchctl", ["bootstrap", gui, plan.file]),
    };
  }
  if (plan.platform === "linux")
    return {
      stop: () => must(run, "systemctl", ["--user", "stop", plan.unit]),
      start: () => must(run, "systemctl", ["--user", "start", plan.unit]),
    };
  const releases = win32.join(plan.home, "releases", "spade") + "\\";
  const script = `$root = '${releases.replaceAll("'", "''")}'
Get-CimInstance Win32_Process -Filter "Name='spade-server.exe'" | Where-Object { ([string]$_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }`;
  return {
    stop: () => {
      // `/End` stops only the task's conhost; the server it started is ended too, and waited for.
      run("schtasks.exe", ["/End", "/TN", plan.name]);
      must(run, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ]);
    },
    start: () => must(run, "schtasks.exe", ["/Run", "/TN", plan.name]),
  };
}

/** The fresh start's Spade handling for `plan`'s home, with `run` as the service manager. */
export function freshStartSpade(
  planFor: (root: string) => SpadeServicePlan,
  run: SyncRunner = systemRun,
): FreshStartSpade {
  return {
    pause(root) {
      const plan = planFor(root);
      // Only this home's Spade: a registration for another ACE_HOME (or one ace didn't write)
      // isn't running from here and is left alone.
      if (readOwnFile(plan.file) !== plan.content) return undefined;
      const manager = spadeServiceSwitch(plan, run);
      manager.stop();
      return {
        resume(backup) {
          carrySpadeProgram(plan, backup);
          // Without its binary (a desktop home keeps no release) Spade stays stopped: the app's
          // next update installs it and starts the service.
          const binary = join(
            plan.home,
            "releases",
            "spade",
            "current",
            spadeBinaryName(plan.platform),
          );
          if (existsSync(binary)) manager.start();
        },
      };
    },
  };
}

/** This machine's account, for the fresh start of `root`. */
export const localFreshStartSpade: FreshStartSpade = freshStartSpade((root) => {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`Spade's service is not available on ${platform}`);
  return spadeServicePlan(root, platform, {
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    ...(platform === "win32"
      ? {
          sid: windowsSid(),
          systemRoot: process.env.SystemRoot ?? "C:\\Windows",
        }
      : {}),
  });
});

function windowsSid(): string {
  return sidFromWhoami(
    execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }),
  );
}
