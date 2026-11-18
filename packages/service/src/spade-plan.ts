import { posix, win32 } from "node:path";
import { z } from "zod";
import { quote, taskXml, xml } from "./plan.ts";
import { homeServiceName } from "./service-name.ts";

/**
 * Spade's per-user service (ADR 0123), registered beside the daemon's and never under it. The
 * service runs `<ACE_HOME>/releases/spade/current/spade` with exactly Spade's environment and
 * appends its output to `<ACE_HOME>/logs/spade.log`. Pure: rendering only, no I/O.
 *
 * These are the default home's names (`~/.ace`). Any other home's service carries a short hash
 * of its path after them (ADR 0185), so two homes on one machine never share a service.
 */
export const spadeLabel = "dev.ace.next.spade";
const spadeUnitBase = "ace-next-spade";
export const spadeUnit = `${spadeUnitBase}.service`;
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
  /**
   * The home the Spade service under the default name runs, when one is registered (the I/O
   * shell reads it). A home registered there before ADR 0185 keeps that name.
   */
  sharedNameHome?: string | undefined;
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
  /**
   * The same registration as builds before the binary's rename rendered it, naming
   * `spade-server`: recognised as ace's own and rewritten, never refused
   * (`spadeRegistrationKind`).
   */
  previous: PreviousSpadeRegistration;
}
export interface PreviousSpadeRegistration {
  content: string;
  command: readonly string[];
  /** Windows: the launcher those builds wrote. */
  launcher?: string;
}
export interface DarwinSpadePlan extends PlanBase {
  platform: "darwin";
  /** `gui/<uid>/<label>`: `dev.ace.next.spade` for the default home. */
  domain: string;
}
export interface LinuxSpadePlan extends PlanBase {
  platform: "linux";
  unit: string;
}
export interface WindowsSpadePlan extends PlanBase {
  platform: "win32";
  /** The task's path in Task Scheduler's root folder: `\ace-next-spade` for the default home. */
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

/** `spade`, or `spade.exe` on Windows. */
export const spadeBinaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "spade.exe" : "spade";

/**
 * The name builds before the rename gave the binary, `spade-server` (`.exe` on Windows). An
 * installed release folder may still hold only that file; `spade-release.ts` adopts it.
 */
export const previousSpadeBinaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "spade-server.exe" : "spade-server";

/**
 * The WQL filter for Spade's processes: `spade.exe`, and `spade-server.exe` as builds before the
 * binary's rename started it, so an update that rewrites the launcher still ends the old one.
 */
export const spadeProcessFilter = `Name='${spadeBinaryName("win32")}' OR Name='${previousSpadeBinaryName("win32")}'`;

/** Spade's service for `home` on `platform`. */
export function spadeServicePlan(
  home: string,
  platform: SpadePlatform,
  account: SpadeAccount,
): SpadeServicePlan {
  const plan = render(home, platform, account, spadeBinaryName(platform));
  const old = render(home, platform, account, previousSpadeBinaryName(platform));
  const previous: PreviousSpadeRegistration = { content: old.content, command: old.command };
  if (old.platform === "win32") previous.launcher = old.launcher.content;
  return { ...plan, previous };
}

/**
 * Which of `plan`'s renderings the registration `content` on disk is: `current`, `previous`
 * (an earlier build's, to be rewritten), or undefined when it is neither, so not ace's.
 */
export function spadeRegistrationKind(
  plan: SpadeServicePlan,
  content: string,
): "current" | "previous" | undefined {
  if (content === plan.content) return "current";
  if (content === plan.previous.content) return "previous";
  return undefined;
}

const unxml = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/**
 * The ace home a Spade registration runs, when it names one: the plist's or unit's
 * `SPADE_ACE_HOME`, or on Windows the home of the launcher the loaded task (`schtasks /Query
 * /XML`) starts. Lets ace tell whose service holds a name instead of overwriting it.
 */
export function registeredSpadeHome(platform: SpadePlatform, content: string): string | undefined {
  if (platform === "darwin") {
    const found = /<key>SPADE_ACE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(content)?.[1];
    return found === undefined ? undefined : unxml(found);
  }
  if (platform === "linux") {
    const found = /"SPADE_ACE_HOME=((?:[^"\\]|\\.)*)"/.exec(content)?.[1];
    return found?.replace(/\\(.)/g, "$1").replaceAll("%%", "%");
  }
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(content)?.[1];
  const launcher = args === undefined ? undefined : /@ "([^"]+)"\s*$/.exec(unxml(args))?.[1];
  const suffix = `\\bin\\${SPADE_CMD_LAUNCHER}`;
  return launcher?.toLowerCase().endsWith(suffix) ? launcher.slice(0, -suffix.length) : undefined;
}

type Rendered =
  | Omit<DarwinSpadePlan, "previous">
  | Omit<LinuxSpadePlan, "previous">
  | Omit<WindowsSpadePlan, "previous">;

function render(
  home: string,
  platform: SpadePlatform,
  account: SpadeAccount,
  binary: string,
): Rendered {
  if (platform === "win32") return windowsPlan(windowsHome.parse(home), account, binary);
  const root = posixHome.parse(home);
  const userHome = posixHome.parse(account.userHome);
  const program = posix.join(root, "releases", "spade", "current", binary);
  const logFile = posix.join(root, "logs", "spade.log");
  const environment = spadeEnvironment(root, platform);
  const owner = { userHome, sharedNameHome: account.sharedNameHome };
  if (platform === "darwin") {
    const uid = Uid.parse(account.uid);
    const label = homeServiceName(spadeLabel, ".", root, owner, platform);
    const variables = environment
      .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
      .join("");
    return {
      platform,
      home: root,
      file: posix.join(userHome, `Library/LaunchAgents/${label}.plist`),
      domain: `gui/${uid}/${label}`,
      command: [program],
      logFile,
      // KeepAlive with the daemon's throttle: a second instance's exit 3 waits 15 s each time.
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
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
  const unit = `${homeServiceName(spadeUnitBase, "-", root, owner, platform)}.service`;
  return {
    platform,
    home: root,
    file: posix.join(userHome, `.config/systemd/user/${unit}`),
    unit,
    command: [program],
    logFile,
    // Exit 3 is a second instance: one already runs, so systemd does not start another.
    content: `[Unit]\nDescription=Spade, ace's assistant\n[Service]\nType=simple\nExecStart=${quote(program.replaceAll("$", "$$$$"))}\nEnvironment=${unitEnvironment}\nRestart=on-failure\nRestartSec=1\nRestartPreventExitStatus=3\nTimeoutStopSec=40s\nKillMode=mixed\nStandardOutput=append:${unitPath(logFile)}\nStandardError=append:${unitPath(logFile)}\n[Install]\nWantedBy=default.target\n`,
  };
}

function windowsPlan(
  home: string,
  account: SpadeAccount,
  binary: string,
): Omit<WindowsSpadePlan, "previous"> {
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
    name: `\\${homeServiceName(spadeTaskName, "-", home, { userHome: text.parse(account.userHome), sharedNameHome: account.sharedNameHome }, "win32")}`,
    program,
    arguments: args,
    user,
    launcher: { file: launcher, content: renderSpadeCmdLauncher(binary) },
  };
}

const versionLine = "[0123456789abcdefghijklmnopqrstuvwxyz.-]*";

/** A cmd.exe variable reference. */
const v = (name: string) => `%${name}%`;
/** Clears every variable whose name starts with `prefix`. */
const clear = (prefix: string) => `for /f "delims==" %%V in ('set ${prefix} 2^>nul') do set "%%V="`;

/** The launcher's own variables: never `ACE_` or `SPADE_`, and gone before Spade starts. */
const launch = {
  home: "SPADELAUNCH_HOME",
  pointer: "SPADELAUNCH_POINTER",
  release: "SPADELAUNCH_RELEASE",
  log: "SPADELAUNCH_LOG",
};

/**
 * `bin\spade.cmd`. Windows keeps `releases\spade\current` as a pointer file naming the version
 * folder (ADR 0095), so the launcher accepts only one plain version line before reading it. The
 * home is the folder above the script's own, never a literal (cmd.exe reads batch files in the
 * OEM code page), so the file is the same for every home.
 *
 * Spade gets exactly its four variables: the person's `ACE_*` and `SPADE_*` variables are
 * cleared first, the launcher's own live inside `setlocal`, and the last line, expanded before
 * `endlocal` runs, drops them, sets Spade's four and starts it. The log is rotated here, before
 * Spade holds it open.
 */
export function renderSpadeCmdLauncher(binary = spadeBinaryName("win32")): string {
  const home = v(launch.home);
  const environment = spadeEnvironment(home, "win32")
    .map(([key, value]) => `set "${key}=${value}"`)
    .join(" & ");
  const log = v(launch.log);
  return [
    "@echo off",
    clear("ACE_"),
    clear("SPADE_"),
    "setlocal DisableDelayedExpansion",
    `for %%I in ("%~dp0..") do set "${launch.home}=%%~fI"`,
    `set "${launch.pointer}=${home}\\releases\\spade\\current"`,
    `findstr /r /x /c:"${versionLine}" <"${v(launch.pointer)}" >nul 2>nul || exit /b 1`,
    `findstr /r /x /v /c:"${versionLine}" <"${v(launch.pointer)}" >nul 2>nul && exit /b 1`,
    `findstr /l /c:".." <"${v(launch.pointer)}" >nul 2>nul && exit /b 1`,
    `set "${launch.release}="`,
    `set /p ${launch.release}=<"${v(launch.pointer)}"`,
    `if not exist "${home}\\logs" mkdir "${home}\\logs"`,
    `set "${launch.log}=${home}\\logs\\spade.log"`,
    `if exist "${log}" for %%F in ("${log}") do if %%~zF GTR 8388608 move /y "${log}" "${log}.previous" >nul`,
    `endlocal & ${environment} & "${home}\\releases\\spade\\${v(launch.release)}\\${binary}" >>"${log}" 2>&1`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}
