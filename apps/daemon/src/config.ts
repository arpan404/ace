import { homedir } from "node:os";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export interface Config {
  dataDir: string;
  host: "127.0.0.1";
  port: number;
  listen: "local" | "lan" | "tailscale";
  remotePort: number;
  advertiseHost?: string;
  logLevel: LogLevel;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ACE_PORT ?? 4242);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("ACE_PORT must be 0..65535");
  const listen = env.ACE_LISTEN ?? "local";
  if (listen !== "local" && listen !== "lan" && listen !== "tailscale")
    throw new Error("ACE_LISTEN must be local, lan or tailscale");
  const remotePort = Number(env.ACE_REMOTE_PORT ?? (port === 0 ? 0 : port + 1));
  if (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65535)
    throw new Error("ACE_REMOTE_PORT must be 0..65535");
  const level = env.ACE_LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error", "silent"].includes(level))
    throw new Error("Invalid ACE_LOG_LEVEL");
  return {
    dataDir: resolve(env.ACE_HOME ?? resolve(homedir(), ".ace")),
    host: "127.0.0.1",
    port,
    listen,
    remotePort,
    ...(env.ACE_ADVERTISE_HOST ? { advertiseHost: env.ACE_ADVERTISE_HOST } : {}),
    logLevel: level as LogLevel,
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
