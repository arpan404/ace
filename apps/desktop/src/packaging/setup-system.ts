import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { z } from "zod";
import { uninstallNativeHost } from "@ace/browser-extension";
import { isDesktopShim, prepareDaemonHome, resolveDaemonHome } from "@ace/service/home";
import { daemonBusy, lockOwner, requestStop } from "../main/daemon/stop-request.ts";
import { installCliShim } from "../main/os/cli-shim-install.ts";
import { cliShimLog } from "../main/os/cli-shim.ts";
import { installDirFrom, runSetup, type SetupCommand, type SetupPorts } from "./setup.ts";
import { userPathRegistry } from "./user-path.ts";

/** The Windows shell around `setup.ts`: PowerShell, taskkill and the real files. */

function powershell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, timeout: 60_000, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    ),
  );
}

/** The folder as a prefix that matches only paths inside it (`C:\app\`, never `C:\app2`). */
const prefix = (directory: string) => win32.resolve(directory).replace(/\\+$/, "") + "\\";

const Processes = z.array(z.object({ pid: z.number().int().positive(), path: z.string() }));

const listScript = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$found=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:ACE_SETUP_DIR,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{ pid=[int]$_.ProcessId; path=[string]$_.ExecutablePath } })",
  "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $found))",
].join("; ");

const loginItemsScript = [
  "$ErrorActionPreference='Stop'",
  "$run='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
  "$approved='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'",
  "$removed=0",
  "$key=Get-Item -LiteralPath $run -ErrorAction SilentlyContinue",
  "if ($key) { foreach ($name in $key.GetValueNames()) { if (([string]$key.GetValue($name)).IndexOf($env:ACE_SETUP_DIR,[StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-ItemProperty -LiteralPath $run -Name $name; Remove-ItemProperty -LiteralPath $approved -Name $name -ErrorAction SilentlyContinue; $removed++ } } }",
  "[Console]::Out.Write($removed)",
].join("; ");

export function systemPorts(installDir: string, env: NodeJS.ProcessEnv): SetupPorts {
  const home = resolveDaemonHome(homedir(), env.ACE_HOME);
  const resources = win32.join(installDir, "resources");
  const own = new Set([process.pid, process.ppid]);
  return {
    installDir,
    home,
    env,
    userPath: userPathRegistry,
    prepareHome: (path) => void prepareDaemonHome(path),
    async writeCommand() {
      const result = await installCliShim({
        dataHome: home,
        platform: "win32",
        node: win32.join(resources, "runtime", "node.exe"),
        entry: win32.join(resources, "daemon", "ace.mjs"),
      });
      if (result.state === "failed") throw new Error(result.message);
      return cliShimLog(result) ?? "unchanged";
    },
    readCommand: (file) =>
      readFile(file, "utf8").then(
        (content) => content.slice(0, 8192),
        () => undefined,
      ),
    isDesktopCommand: isDesktopShim,
    removeFile: (file) => rm(file, { force: true }),
    daemonPid: lockOwner,
    requestStop: (path, pid) => requestStop(path, pid),
    busy: (path, pid) => daemonBusy(path, pid),
    async processesIn(directory) {
      const output = await powershell(listScript, { ACE_SETUP_DIR: prefix(directory) });
      return Processes.parse(JSON.parse(output.trim() || "[]")).filter(
        (found) => !own.has(found.pid),
      );
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
      }
    },
    kill: (pid) =>
      new Promise((resolve) =>
        execFile("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true }, () =>
          resolve(),
        ),
      ),
    async removeLoginItems(directory) {
      return Number(await powershell(loginItemsScript, { ACE_SETUP_DIR: prefix(directory) }));
    },
    removeNativeHosts: (path) =>
      uninstallNativeHost({ platform: "win32", home: homedir(), dataDir: path, env }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(`[ace setup] ${line}`),
  };
}

const Command = z.enum(["install", "update", "stop", "force-stop", "uninstall"]);

/** `node ace-setup.mjs install|update|stop|uninstall`, run by the NSIS installer. */
export async function main(argv: readonly string[], scriptDirectory: string): Promise<void> {
  const command: SetupCommand = Command.parse(argv[0]);
  await runSetup(command, systemPorts(installDirFrom(scriptDirectory), process.env));
}
