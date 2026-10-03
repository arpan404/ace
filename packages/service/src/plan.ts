import { join } from "node:path";
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
      file: join(c.home, "Library/LaunchAgents/dev.ace.daemon.plist"),
      domain: `gui/${c.uid}/dev.ace.daemon`,
      logDir,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>dev.ace.daemon</string>
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
    file: join(c.home, ".config/systemd/user/ace.service"),
    domain: "ace.service",
    logDir,
    content: `[Unit]\nDescription=ace local daemon\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=${quote(c.executable.replaceAll("$", () => "$$"))} supervise\nEnvironment=${unitEnvironment}\nRestart=always\nRestartSec=15s\nTimeoutStopSec=60s\nKillMode=control-group\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=ace\n[Install]\nWantedBy=default.target\n`,
  };
}
