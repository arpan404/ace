import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveDaemonHome } from "@ace/service";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { WebOrigins } from "./web-origins.ts";
import { LogMaxBytes, RetentionDays, type SettingsValues } from "@ace/protocol";
import { parseByteSize } from "@ace/diagnostics/log-policy";

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
  /** Development only: "1" keeps macOS permissions with the launching terminal. */
  ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY: z.enum(["0", "1"]).optional(),
  ACE_HOME: z.string().optional(),
  ACE_ATTACHMENT_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  ACE_ATTACHMENT_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  ACE_CURSOR_SDK_HOME: z.string().min(1).optional(),
  ACE_WORKSPACE_ROOT: z.string().optional(),
  ACE_RELAY_URL: z.url().optional(),
  ACE_ADVERTISE_HOST: z.string().optional(),
  ACE_WEB_ORIGINS: WebOrigins.optional(),
  /** Overrides the saved `storage.retentionDays` while set. */
  ACE_RETENTION_DAYS: z.coerce.number().pipe(RetentionDays).optional(),
  /** Overrides the saved `logs.maxBytes` while set. Accepts `1g`, `512m` or plain bytes. */
  ACE_LOG_MAX_BYTES: z
    .string()
    .transform((value, context) => {
      const bytes = parseByteSize(value);
      if (bytes === undefined) {
        context.addIssue({ code: "custom", message: "Use a size such as 1g, 512m or 1048576" });
        return z.NEVER;
      }
      return bytes;
    })
    .pipe(LogMaxBytes)
    .optional(),
});
export interface Config {
  dataDir: string;
  attachmentLimits?: { fileBytes?: number; messageBytes?: number };
  /** Private instance root; the SDK uses its user subdirectory as HOME. */
  cursorSdkHome?: string;
  workspaceRoot?: string;
  relayUrl?: string;
  host: "127.0.0.1";
  port: number;
  listen: "local" | "lan" | "tailscale";
  /** An explicit ACE_LISTEN wins over saved remote preferences. */
  listenOverride?: boolean;
  remotePort: number;
  advertiseHost?: string;
  /** Origins of web apps served elsewhere that may manage devices with the token (ACE_WEB_ORIGINS). */
  webOrigins?: readonly string[];
  logLevel: LogLevel;
  /**
   * Settings pinned by environment variables. They win over saved settings (the same
   * convention as ACE_LISTEN); saved values apply again once the variable is unset.
   */
  settingsOverrides?: Partial<Pick<SettingsValues, "storage.retentionDays" | "logs.maxBytes">>;
  screenHelper?: string;
  /** The helper manifest when it does not sit beside the app (the desktop bundle). */
  screenHelperManifest?: string;
  /** Development only: the helper's macOS permissions follow the process that launched ace. */
  screenHelperInheritsResponsibility?: boolean;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const settings = Environment.parse(env);
  assertTestEnvironmentIsolation(env);
  const port = settings.ACE_PORT;
  const remotePort = settings.ACE_REMOTE_PORT ?? (port === 0 || port === 65535 ? 0 : port + 1);
  return {
    ...(settings.ACE_SCREEN_HELPER ? { screenHelper: resolve(settings.ACE_SCREEN_HELPER) } : {}),
    ...(settings.ACE_SCREEN_HELPER_MANIFEST
      ? { screenHelperManifest: resolve(settings.ACE_SCREEN_HELPER_MANIFEST) }
      : {}),
    ...(settings.ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY === "1"
      ? { screenHelperInheritsResponsibility: true }
      : {}),
    dataDir: resolveDaemonHome(home, settings.ACE_HOME),
    attachmentLimits: {
      ...(settings.ACE_ATTACHMENT_FILE_BYTES
        ? { fileBytes: settings.ACE_ATTACHMENT_FILE_BYTES }
        : {}),
      ...(settings.ACE_ATTACHMENT_MESSAGE_BYTES
        ? { messageBytes: settings.ACE_ATTACHMENT_MESSAGE_BYTES }
        : {}),
    },
    ...(settings.ACE_CURSOR_SDK_HOME
      ? { cursorSdkHome: resolve(settings.ACE_CURSOR_SDK_HOME) }
      : {}),
    ...(settings.ACE_WORKSPACE_ROOT ? { workspaceRoot: resolve(settings.ACE_WORKSPACE_ROOT) } : {}),
    ...(settings.ACE_RELAY_URL ? { relayUrl: settings.ACE_RELAY_URL } : {}),
    host: "127.0.0.1",
    port,
    listen: settings.ACE_LISTEN,
    listenOverride: env.ACE_LISTEN !== undefined,
    remotePort,
    ...(settings.ACE_ADVERTISE_HOST ? { advertiseHost: settings.ACE_ADVERTISE_HOST } : {}),
    ...(settings.ACE_WEB_ORIGINS ? { webOrigins: settings.ACE_WEB_ORIGINS } : {}),
    logLevel: settings.ACE_LOG_LEVEL,
    settingsOverrides: {
      ...(settings.ACE_RETENTION_DAYS !== undefined
        ? { "storage.retentionDays": settings.ACE_RETENTION_DAYS }
        : {}),
      ...(settings.ACE_LOG_MAX_BYTES !== undefined
        ? { "logs.maxBytes": settings.ACE_LOG_MAX_BYTES }
        : {}),
    },
  };
}
