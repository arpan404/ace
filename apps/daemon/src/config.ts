import { homedir } from "node:os";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export interface Config {
  dataDir: string;
  host: "127.0.0.1";
  port: number;
  logLevel: LogLevel;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.ACE_PORT ?? 4242);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("ACE_PORT must be 0..65535");
  const level = env.ACE_LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error", "silent"].includes(level))
    throw new Error("Invalid ACE_LOG_LEVEL");
  return {
    dataDir: resolve(env.ACE_HOME ?? resolve(homedir(), ".ace")),
    host: "127.0.0.1",
    port,
    logLevel: level as LogLevel,
  };
}
