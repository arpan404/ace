import { join } from "node:path";
import { win32 } from "node:path";
import { z } from "zod";
const text = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) =>
    Array.from(v).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
const absolute = text.refine((v) => v.startsWith("/"));
const port = z
  .string()
  .regex(/^\d{1,5}$/)
  .refine((value) => Number(value) <= 65535);
export const ServiceEnvironment = z.object({
  ACE_PORT: port.optional(),
  ACE_REMOTE_PORT: port.optional(),
  ACE_LISTEN: z.enum(["local", "lan", "tailscale"]).optional(),
  ACE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
  ACE_ADVERTISE_HOST: text.optional(),
  /** Validated by the daemon's own config (comma-separated http(s) origins). */
  ACE_WEB_ORIGINS: text.optional(),
});
export const ServiceConfig = z.object({
  environment: ServiceEnvironment.default({}),
  updatePolicy: z.enum(["daily", "manual"]).default("daily"),
  platform: z.enum(["darwin", "linux"]),
  home: absolute,
  dataDir: absolute,
  executable: absolute,
  path: text,
  uid: z.number().int().nonnegative(),
});
export type ServiceConfig = z.input<typeof ServiceConfig>;
export interface ServicePlan {
  platform: ServiceConfig["platform"];
  command: readonly [string, "supervise"];
  file: string;
  content: string;
  domain: string;
  logDir: string;
}
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const quote = (s: string) =>
  '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
export function planService(input: ServiceConfig): ServicePlan {
  const c = ServiceConfig.parse(input);
  const logDir = join(c.dataDir, "logs");
  const label = "dev.ace.next.daemon";
  const unit = "ace-next.service";
  const variables: [string, string][] = [
    ["ACE_HOME", c.dataDir],
    ["PATH", c.path],
    ["ACE_AUTO_UPDATE", c.updatePolicy === "daily" ? "1" : "0"],
  ];
  for (const [key, value] of Object.entries(c.environment))
    if (value !== undefined) variables.push([key, value]);
  const plistEnvironment = variables
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  const unitEnvironment = variables.map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  if (c.platform === "darwin")
    return {
      platform: c.platform,
      command: [c.executable, "supervise"],
      file: join(c.home, `Library/LaunchAgents/${label}.plist`),
      domain: `gui/${c.uid}/${label}`,
      logDir,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(c.executable)}</string><string>supervise</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>EnvironmentVariables</key><dict>${plistEnvironment}</dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`,
    };
  return {
    platform: c.platform,
    command: [c.executable, "supervise"],
    file: join(c.home, `.config/systemd/user/${unit}`),
    domain: unit,
    logDir,
    content: `[Unit]\nDescription=ace local daemon\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=${quote(c.executable.replaceAll("$", () => "$$"))} supervise\nEnvironment=${unitEnvironment}\nRestart=always\nRestartSec=15s\nTimeoutStopSec=60s\nKillMode=control-group\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=ace\n[Install]\nWantedBy=default.target\n`,
  };
}

const windowsAbsolute = text.refine((v) => /^[A-Za-z]:\\/.test(v));
/** A per-user Task Scheduler task (Windows). */
export const TaskConfig = z.object({
  environment: ServiceEnvironment.default({}),
  updatePolicy: z.enum(["daily", "manual"]).default("daily"),
  dataDir: windowsAbsolute,
  /** The home's `bin\ace.cmd` launcher. */
  executable: windowsAbsolute,
  path: text,
  /** The account's SID, from `whoami /user`. */
  user: z.string().regex(/^S-1-\d+(?:-\d+){1,14}$/),
  systemRoot: windowsAbsolute,
  name: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .default("ace-next-daemon"),
});
export type TaskConfig = z.input<typeof TaskConfig>;
export interface TaskPlan {
  platform: "win32";
  command: readonly [string, "supervise"];
  /** The task's path in the Task Scheduler root folder, such as `\ace-next-daemon`. */
  name: string;
  /** ace's copy of the registered task XML, the record later registrations are checked against. */
  file: string;
  content: string;
  /** The service environment the supervisor applies; a task has no environment of its own. */
  environmentFile: string;
  environment: string;
  logDir: string;
  user: string;
  program: string;
  arguments: string;
}
/**
 * The login service on Windows. A Task Scheduler task rather than an HKCU Run entry, because
 * only a task restarts on failure, starts without a console window and can be stopped.
 */
export function planTask(input: TaskConfig): TaskPlan {
  const c = TaskConfig.parse(input);
  const variables: Record<string, string> = {
    ACE_HOME: c.dataDir,
    PATH: c.path,
    ACE_AUTO_UPDATE: c.updatePolicy === "daily" ? "1" : "0",
  };
  for (const [key, value] of Object.entries(c.environment))
    if (value !== undefined) variables[key] = value;
  // A console node.exe started by Task Scheduler opens a window; headless conhost hosts it
  // without one, and the launcher's console processes inherit that hidden console.
  const program = win32.join(c.systemRoot, "System32", "conhost.exe");
  const args = `--headless "${c.executable}" supervise`;
  const content = `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>ace local daemon</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(c.user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(c.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(program)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
`;
  return {
    platform: "win32",
    command: [c.executable, "supervise"],
    name: `\\${c.name}`,
    file: win32.join(c.dataDir, "service", "task.xml"),
    content,
    environmentFile: win32.join(c.dataDir, "service", "environment.json"),
    environment: JSON.stringify(variables) + "\n",
    logDir: win32.join(c.dataDir, "logs"),
    user: c.user,
    program,
    arguments: args,
  };
}
