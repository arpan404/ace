import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;
const portSchema = z.coerce.number().int().min(0).max(65535);
const Environment = z.object({
  ACE_PORT: portSchema.default(4242),
  ACE_REMOTE_PORT: portSchema.optional(),
  ACE_LISTEN: z.enum(["local", "lan", "tailscale"]).default("local"),
  ACE_LOG_LEVEL: LogLevelSchema.default("info"),
  ACE_HOME: z.string().optional(),
  ACE_WORKSPACE_ROOT: z.string().optional(),
  ACE_RELAY_URL: z.url().optional(),
  ACE_ADVERTISE_HOST: z.string().optional(),
});
export interface Config {
  dataDir: string;
  workspaceRoot?: string;
  relayUrl?: string;
  host: "127.0.0.1";
  port: number;
  listen: "local" | "lan" | "tailscale";
  remotePort: number;
  advertiseHost?: string;
  logLevel: LogLevel;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const settings = Environment.parse(env);
  const port = settings.ACE_PORT;
  const remotePort = settings.ACE_REMOTE_PORT ?? (port === 0 || port === 65535 ? 0 : port + 1);
  return {
    dataDir: resolve(settings.ACE_HOME ?? resolve(homedir(), ".ace")),
    ...(settings.ACE_WORKSPACE_ROOT ? { workspaceRoot: resolve(settings.ACE_WORKSPACE_ROOT) } : {}),
    ...(settings.ACE_RELAY_URL ? { relayUrl: settings.ACE_RELAY_URL } : {}),
    host: "127.0.0.1",
    port,
    listen: settings.ACE_LISTEN,
    remotePort,
    ...(settings.ACE_ADVERTISE_HOST ? { advertiseHost: settings.ACE_ADVERTISE_HOST } : {}),
    logLevel: settings.ACE_LOG_LEVEL,
  };
}
export function logger(
  level: LogLevel,
): (severity: Exclude<LogLevel, "silent">, message: string, error?: unknown) => void {
  const levels = ["debug", "info", "warn", "error", "silent"];
  return (severity, message, error) => {
    if (levels.indexOf(severity) < levels.indexOf(level)) return;
    process.stderr.write(
      JSON.stringify({
        at: Date.now(),
        level: severity,
        message,
        ...(error === undefined ? {} : { error: String(error) }),
      }) + "\n",
    );
  };
}
