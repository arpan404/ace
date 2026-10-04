import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveDaemonHome } from "@ace/service";
import { WebOrigins } from "./web-origins.ts";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;
const portSchema = z.coerce.number().int().min(0).max(65535);
const Environment = z.object({
  ACE_PORT: portSchema.default(4242),
  ACE_REMOTE_PORT: portSchema.optional(),
  ACE_LISTEN: z.enum(["local", "lan", "tailscale"]).default("local"),
  ACE_LOG_LEVEL: LogLevelSchema.default("info"),
  ACE_SCREEN_HELPER: z.string().min(1).optional(),
  ACE_SCREEN_HELPER_MANIFEST: z.string().min(1).optional(),
  ACE_HOME: z.string().optional(),
  ACE_CURSOR_SDK_HOME: z.string().min(1).optional(),
  ACE_WORKSPACE_ROOT: z.string().optional(),
  ACE_RELAY_URL: z.url().optional(),
  ACE_ADVERTISE_HOST: z.string().optional(),
  ACE_WEB_ORIGINS: WebOrigins.optional(),
});
export interface Config {
  dataDir: string;
  /** Private instance root; the SDK uses its user subdirectory as HOME. */
  cursorSdkHome?: string;
  workspaceRoot?: string;
  relayUrl?: string;
  host: "127.0.0.1";
  port: number;
  listen: "local" | "lan" | "tailscale";
  remotePort: number;
  advertiseHost?: string;
  /** Origins of web apps served elsewhere that may manage devices with the token (ACE_WEB_ORIGINS). */
  webOrigins?: readonly string[];
  logLevel: LogLevel;
  screenHelper?: string;
  /** The helper manifest when it does not sit beside the app (the desktop bundle). */
  screenHelperManifest?: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const settings = Environment.parse(env);
  const port = settings.ACE_PORT;
  const remotePort = settings.ACE_REMOTE_PORT ?? (port === 0 || port === 65535 ? 0 : port + 1);
  return {
    ...(settings.ACE_SCREEN_HELPER ? { screenHelper: resolve(settings.ACE_SCREEN_HELPER) } : {}),
    ...(settings.ACE_SCREEN_HELPER_MANIFEST
      ? { screenHelperManifest: resolve(settings.ACE_SCREEN_HELPER_MANIFEST) }
      : {}),
    dataDir: resolveDaemonHome(home, settings.ACE_HOME),
    ...(settings.ACE_CURSOR_SDK_HOME
      ? { cursorSdkHome: resolve(settings.ACE_CURSOR_SDK_HOME) }
      : {}),
    ...(settings.ACE_WORKSPACE_ROOT ? { workspaceRoot: resolve(settings.ACE_WORKSPACE_ROOT) } : {}),
    ...(settings.ACE_RELAY_URL ? { relayUrl: settings.ACE_RELAY_URL } : {}),
    host: "127.0.0.1",
    port,
    listen: settings.ACE_LISTEN,
    remotePort,
    ...(settings.ACE_ADVERTISE_HOST ? { advertiseHost: settings.ACE_ADVERTISE_HOST } : {}),
    ...(settings.ACE_WEB_ORIGINS ? { webOrigins: settings.ACE_WEB_ORIGINS } : {}),
    logLevel: settings.ACE_LOG_LEVEL,
  };
}
