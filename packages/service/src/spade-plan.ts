import { posix, win32 } from "node:path";
import { z } from "zod";
import { quote, taskXml, xml } from "./plan.ts";

/**
 * Spade's per-user service (ADR 0123), registered beside the daemon's and never under it. The
 * service runs `<ACE_HOME>/releases/spade/current/spade-server` with exactly Spade's environment
 * and appends its output to `<ACE_HOME>/logs/spade.log`. Pure: rendering only, no I/O.
 */
export const spadeLabel = "dev.ace.next.spade";
export const spadeUnit = "ace-next-spade.service";
export const spadeTaskName = "ace-next-spade";
/** The Windows launcher the task runs, in the home's `bin` folder beside `ace.cmd`. */
export const SPADE_CMD_LAUNCHER = "spade.cmd";

export type SpadePlatform = "darwin" | "linux" | "win32";

/** Who the service runs as: what the service manager needs beyond ACE_HOME. */
export interface SpadeAccount {
  /** The person's home folder (launchd agents and systemd user units live under it). */
  userHome: string;
  /** macOS: the launchd GUI domain's uid. */
  uid?: number;
  /** Windows: the account's SID, from `whoami /user`. */
  sid?: string;
  /** Windows: `%SystemRoot%`. */
  systemRoot?: string;
}

interface PlanBase {
  /** ACE_HOME. */
  home: string;
  /** The registration file ace writes and later compares, byte for byte. */
  file: string;
  content: string;
  /** What the service manager runs, with its arguments, first item the program. */
  command: readonly string[];
  logFile: string;
}
export interface DarwinSpadePlan extends PlanBase {
  platform: "darwin";
  /** `gui/<uid>/dev.ace.next.spade`. */
  domain: string;
}
export interface LinuxSpadePlan extends PlanBase {
  platform: "linux";
  unit: string;
}
export interface WindowsSpadePlan extends PlanBase {
  platform: "win32";
  /** The task's path in Task Scheduler's root folder, `\ace-next-spade`. */
  name: string;
  program: string;
  arguments: string;
  user: string;
  /** `<home>\bin\spade.cmd`, which reads the `current` pointer file and starts Spade. */
  launcher: { file: string; content: string };
}
export type SpadeServicePlan = DarwinSpadePlan | LinuxSpadePlan | WindowsSpadePlan;

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => Array.from(value).every((char) => char >= " " && char !== "\x7f"));
const posixHome = text.refine((value) => value.startsWith("/"), "Must be an absolute path");
// cmd.exe expands `%` in the launcher's command line, and Windows paths never hold `"`.
const windowsHome = text.refine(
  (value) => /^[A-Za-z]:\\/.test(value) && !/[%"]/.test(value),
  "Must be an absolute Windows path without % or quotes",
);

const Uid = z.number().int().nonnegative();
const Sid = z.string().regex(/^S-1-\d+(?:-\d+){1,14}$/);

/** A path in a systemd `append:` setting, its `%` specifiers escaped. */
const unitPath = (value: string) => value.replaceAll("%", "%%");

/** Spade's environment, exactly: the contract's four variables and nothing else. */
export function spadeEnvironment(home: string, platform: SpadePlatform): [string, string][] {
  const path = platform === "win32" ? win32 : posix;
  return [
    ["SPADE_DATA_DIR", path.join(home, "spade")],
    ["SPADE_ACE_HOME", home],
    ["SPADE_LISTEN", "127.0.0.1:0"],
    ["RUST_LOG", "info"],
  ];
}

/** `spade-server`, or `spade-server.exe` on Windows. */
export const spadeBinaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "spade-server.exe" : "spade-server";

/** Spade's service for `home` on `platform`. */
export function spadeServicePlan(
  home: string,
  platform: SpadePlatform,
  account: SpadeAccount,
): SpadeServicePlan {
  if (platform === "win32") return windowsPlan(windowsHome.parse(home), account);
  const root = posixHome.parse(home);
  const userHome = posixHome.parse(account.userHome);
  const program = posix.join(root, "releases", "spade", "current", "spade-server");
  const logFile = posix.join(root, "logs", "spade.log");
  const environment = spadeEnvironment(root, platform);
  if (platform === "darwin") {
    const uid = Uid.parse(account.uid);
    const variables = environment
      .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
      .join("");
    return {
      platform,
      home: root,
      file: posix.join(userHome, `Library/LaunchAgents/${spadeLabel}.plist`),
      domain: `gui/${uid}/${spadeLabel}`,
      command: [program],
      logFile,
      // KeepAlive with the daemon's throttle: a second instance's exit 3 waits 15 s each time.
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>${spadeLabel}</string>
<key>ProgramArguments</key><array><string>${xml(program)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>EnvironmentVariables</key><dict>${variables}</dict>
<key>StandardOutPath</key><string>${xml(logFile)}</string>
<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>\n`,
    };
  }
  const unitEnvironment = environment.map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  return {
    platform,
    home: root,
    file: posix.join(userHome, `.config/systemd/user/${spadeUnit}`),
    unit: spadeUnit,
    command: [program],
    logFile,
    // Exit 3 is a second instance: one already runs, so systemd does not start another.
    content: `[Unit]\nDescription=Spade, ace's assistant\n[Service]\nType=simple\nExecStart=${quote(program.replaceAll("$", "$$$$"))}\nEnvironment=${unitEnvironment}\nRestart=on-failure\nRestartSec=1\nRestartPreventExitStatus=3\nTimeoutStopSec=40s\nKillMode=mixed\nStandardOutput=append:${unitPath(logFile)}\nStandardError=append:${unitPath(logFile)}\n[Install]\nWantedBy=default.target\n`,
  };
}

function windowsPlan(home: string, account: SpadeAccount): WindowsSpadePlan {
  const user = Sid.parse(account.sid);
  const systemRoot = windowsHome.parse(account.systemRoot ?? "C:\\Windows");
  const launcher = win32.join(home, "bin", SPADE_CMD_LAUNCHER);
  // As the daemon's task: headless conhost hosts the console program without a window, and
  // cmd.exe runs the launcher, the leading `@` keeping cmd from stripping its quotes.
  const program = win32.join(systemRoot, "System32", "conhost.exe");
  const cmd = win32.join(systemRoot, "System32", "cmd.exe");
  const args = `--headless "${cmd}" /d /c @ "${launcher}"`;
  return {
    platform: "win32",
    home,
    file: win32.join(home, "service", "spade-task.xml"),
    content: taskXml({ description: "Spade, ace's assistant", user, program, args }),
    command: [launcher],
    logFile: win32.join(home, "logs", "spade.log"),
    name: `\\${spadeTaskName}`,
    program,
    arguments: args,
    user,
    launcher: { file: launcher, content: renderSpadeCmdLauncher() },
  };
}

const versionLine = "[0123456789abcdefghijklmnopqrstuvwxyz.-]*";

/**
 * `bin\spade.cmd`. Windows keeps `releases\spade\current` as a pointer file naming the version
 * folder (ADR 0095), so the launcher accepts only one plain version line before reading it. The
 * home is the folder above the script's own, never a literal (cmd.exe reads batch files in the
 * OEM code page), so the file is the same for every home.
 */
export function renderSpadeCmdLauncher(): string {
  const environment = spadeEnvironment("%ACE_HOME%", "win32").map(
    ([key, value]) => `set "${key}=${value}"`,
  );
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `for %%I in ("%~dp0..") do set "ACE_HOME=%%~fI"`,
    `set "SPADE_POINTER=%ACE_HOME%\\releases\\spade\\current"`,
    `findstr /r /x /c:"${versionLine}" <"%SPADE_POINTER%" >nul 2>nul || exit /b 1`,
    `findstr /r /x /v /c:"${versionLine}" <"%SPADE_POINTER%" >nul 2>nul && exit /b 1`,
    `findstr /l /c:".." <"%SPADE_POINTER%" >nul 2>nul && exit /b 1`,
    `set "SPADE_RELEASE="`,
    `set /p SPADE_RELEASE=<"%SPADE_POINTER%"`,
    ...environment,
    `if not exist "%ACE_HOME%\\logs" mkdir "%ACE_HOME%\\logs"`,
    `"%ACE_HOME%\\releases\\spade\\%SPADE_RELEASE%\\spade-server.exe" >>"%ACE_HOME%\\logs\\spade.log" 2>&1`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}
