import { assertCompatibleService } from "./compatibility.ts";
import { assertTestHomeIsolation } from "./test-home-guard.ts";
import { assertCompatibleHome, prepareDaemonHome } from "./home.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { z } from "zod";
import { planService, ServiceEnvironment } from "./plan.ts";
import { UserService } from "./service.ts";
import { enableLinger } from "./linger.ts";
import { runProcess } from "./process.ts";
import { withInstallLock } from "./files.ts";
import { readFile } from "node:fs/promises";
import { planTask } from "./plan.ts";
import { TaskService } from "./service.ts";
import { assertCompatibleTask } from "./compatibility.ts";
import { CMD_LAUNCHER } from "./launcher.ts";
import { isDesktopShim } from "./launcher.ts";
import { checked } from "./process.ts";
import { spawn } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";

const windowsLinger =
  "--linger is not available on Windows: ace's task runs while you are logged on, from logon to sign-out.";

/** The Windows login service for `dataDir`: a Task Scheduler task for the current user. */
function localTask(dataDir: string) {
  assertCompatibleHome(dataDir);
  assertTestHomeIsolation(homedir());
  let plan: ReturnType<typeof planTask> | undefined;
  const lazy = {
    async perform(action: "install" | "uninstall" | "start" | "stop" | "status") {
      plan ??= planTask({
        environment: ServiceEnvironment.parse(process.env),
        updatePolicy: process.env.ACE_AUTO_UPDATE === "0" ? "manual" : "daily",
        dataDir,
        executable: join(dataDir, "bin", CMD_LAUNCHER),
        path: process.env.PATH ?? "",
        user: await currentUserSid(),
        systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      });
      const task = plan;
      return new TaskService(task, {
        run: runProcess,
        preflight: () => assertCompatibleTask(task, dataDir),
        requestStop: () => requestDaemonStop(dataDir),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }).perform(action);
    },
  };
  return lazy;
}

/**
 * Windows uninstall. A running program's files cannot be deleted there, and this command
 * usually runs from the installed release itself, so that one release is removed by a hidden
 * PowerShell once this process has exited; everything else goes now.
 */
async function removeCmdInstallation<T>(dataDir: string, result: T): Promise<T> {
  const releases = join(dataDir, "releases");
  if (existsSync(releases) && !(await lstat(releases)).isDirectory())
    throw new Error("Invalid releases directory");
  const launcher = join(dataDir, "bin", CMD_LAUNCHER);
  // The desktop app's `ace` command stays, and with it the PATH entry the app also writes.
  const desktop = isDesktopShim(await readFile(launcher, "utf8").catch(() => ""));
  if (!desktop) await removeFromUserPath(join(dataDir, "bin"));
  for (const name of [join("bin", "ace"), "current", "previous"])
    await rm(join(dataDir, name), { force: true });
  const running = existsSync(releases)
    ? (relative(releases, process.argv[1] ?? "").split(sep)[0] ?? "")
    : "";
  const fromRelease = running !== "" && !running.startsWith("..") && !isAbsolute(running);
  if (existsSync(releases)) {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(releases))
      if (name !== running) await rm(join(releases, name), { recursive: true, force: true });
  }
  if (!fromRelease) {
    if (!desktop) await rm(launcher, { force: true });
    await rm(releases, { recursive: true, force: true });
    return result;
  }
  // cmd.exe reads ace.cmd again after node returns, so the launcher goes once both have exited.
  // A detached cmd.exe outlives this process (a detached PowerShell has no console and quits).
  const release = join(releases, running);
  const remove = `rmdir /s /q "${release}" 2>nul`;
  const command = [
    "ping -n 4 127.0.0.1 >nul",
    remove,
    "ping -n 3 127.0.0.1 >nul",
    remove,
    `rmdir "${releases}" 2>nul`,
    ...(desktop
      ? []
      : [`if not exist "${join(dataDir, "current")}" del /f /q "${launcher}" 2>nul`]),
  ].join(" & ");
  spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
  return result;
}

/**
 * Takes `bin` off the per-user PATH (`HKCU\Environment\Path`), as install.ps1 put it there.
 * Only entries naming it go; every other entry, empty ones included, stays exactly as written,
 * and the value keeps its registry type (REG_EXPAND_SZ stays expandable). The path travels in
 * an environment variable, so any characters survive.
 */
async function removeFromUserPath(bin: string): Promise<void> {
  const script = `$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if (-not $key) { exit 0 }
try {
  $raw = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
  if ($null -eq $raw) { exit 0 }
  $normal = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\\').ToLowerInvariant() }
  $bin = & $normal $env:ACE_REMOVED_PATH_ENTRY
  $entries = @($raw -split ';')
  $kept = @($entries | Where-Object { -not ($_.Trim() -and ((& $normal $_) -eq $bin)) })
  if ($kept.Count -eq $entries.Count) { exit 0 }
  $key.SetValue('Path', ($kept -join ';'), $key.GetValueKind('Path'))
} finally { $key.Close() }
# Clearing an unset variable through .NET broadcasts WM_SETTINGCHANGE, so new terminals see it.
[Environment]::SetEnvironmentVariable('ACE_PATH_CHANGED', $null, 'User')`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, ACE_REMOVED_PATH_ENTRY: bin }, stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Cannot update the user PATH")),
    );
  });
}

/** The signed-in account's SID; `whoami /user` prints it as the second CSV field. */
async function currentUserSid(): Promise<string> {
  const { stdout } = await checked(runProcess, "whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(stdout.trim())?.[1];
  if (!sid) throw new Error("Cannot read the current user's SID");
  return sid;
}

/** `POST /v1/stop` to the daemon serving `dataDir`, as `ace stop` does. */
async function requestDaemonStop(dataDir: string): Promise<boolean> {
  try {
    const origin = (await readFile(join(dataDir, "daemon-endpoint"), "utf8")).trim();
    const token = (await readFile(join(dataDir, "daemon-token"), "utf8")).trim();
    if (new URL(origin).hostname !== "127.0.0.1" || !/^[a-f0-9]{64}$/.test(token)) return false;
    const response = await fetch(new URL("/v1/stop", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
/** OS/environment discovery belongs only in this local I/O boundary. */
export function localService(dataDir: string) {
  if (process.platform === "win32") return localTask(dataDir);
  assertCompatibleHome(dataDir);
  const home = homedir();
  assertTestHomeIsolation(home);
  const plan = planService({
    environment: ServiceEnvironment.parse(process.env),
    updatePolicy: process.env.ACE_AUTO_UPDATE === "0" ? "manual" : "daily",
    platform: z.enum(["darwin", "linux"]).parse(process.platform),
    home,
    dataDir,
    executable: join(dataDir, "bin/ace"),
    path: process.env.PATH ?? "/usr/bin:/bin",
    uid: process.getuid?.() ?? 0,
  });
  return new UserService(plan, runProcess, () => assertCompatibleService(plan, dataDir));
}
export async function serviceCommand(dataDir: string, args: string[]) {
  // A service names the home's launcher, so the home's format is settled first: an older home
  // and whatever binary it holds are set aside, never registered or run.
  prepareDaemonHome(dataDir);
  const action = z.enum(["install", "uninstall", "start", "stop", "status"]).parse(args[0]);
  const linger = args[1] === "--linger" && args.length === 2 && action === "install";
  if (linger && process.platform === "win32") throw new Error(windowsLinger);
  if (linger && process.platform !== "linux") throw new Error("--linger requires Linux systemd");
  if (args.length !== 1 && !linger)
    throw new Error("Usage: ace service install|uninstall|start|stop|status");
  if (action === "install" && process.platform === "win32" && !existsSync(join(dataDir, "current")))
    throw new Error(
      existsSync(join(dataDir, "bin", CMD_LAUNCHER))
        ? "Install a daemon artifact before registering its service: this home's ace command is the desktop app's, which runs its own daemon. Install a release with install.ps1 to run one at login without the app."
        : "Install a daemon artifact before registering its service",
    );
  // A service runs an installed release; the desktop app's `ace` command shim is not one.
  if (action === "install" && !existsSync(join(dataDir, "current")))
    throw new Error(
      existsSync(join(dataDir, "bin/ace"))
        ? "Install a daemon artifact before registering its service: this home's ace command is the desktop app's, which runs its own daemon. Install a release with install.sh to run one at login without the app."
        : "Install a daemon artifact before registering its service",
    );
  if (action !== "uninstall") {
    const result = await localService(dataDir).perform(action);
    if (linger) await enableLinger(process.platform, process.getuid?.() ?? -1, runProcess);
    return { ...result, ...(linger ? { linger: true } : {}) };
  }
  return withInstallLock(dataDir, async () => {
    if (existsSync(join(dataDir, "update.json")))
      throw new Error("Recover the pending update before uninstalling");
    const result = await localService(dataDir).perform(action);
    if (process.platform === "win32") return removeCmdInstallation(dataDir, result);
    for (const name of ["bin/ace", "current", "previous", "releases"]) {
      const path = join(dataDir, name);
      if (name === "releases" && existsSync(path) && !(await lstat(path)).isDirectory())
        throw new Error("Invalid releases directory");
      await rm(path, { recursive: true, force: true });
    }
    return result;
  });
}
