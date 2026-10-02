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
export const ServiceConfig = z.object({
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
<key>EnvironmentVariables</key><dict><key>ACE_HOME</key><string>${xml(c.dataDir)}</string><key>PATH</key><string>${xml(c.path)}</string><key>ACE_AUTO_UPDATE</key><string>${c.updatePolicy === "daily" ? "1" : "0"}</string></dict>
<key>StandardOutPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, "daemon.err.log"))}</string>
</dict></plist>\n`,
    };
  return {
    platform: c.platform,
    file: join(c.home, ".config/systemd/user/ace.service"),
    domain: "ace.service",
    logDir,
    content: `[Unit]\nDescription=ace local daemon\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=${quote(c.executable.replaceAll("$", () => "$$"))} supervise\nEnvironment=${quote(`ACE_HOME=${c.dataDir}`)} ${quote(`PATH=${c.path}`)} ${quote(`ACE_AUTO_UPDATE=${c.updatePolicy === "daily" ? "1" : "0"}`)}\nRestart=always\nRestartSec=15s\nTimeoutStopSec=60s\nKillMode=control-group\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=ace\n[Install]\nWantedBy=default.target\n`,
  };
}
