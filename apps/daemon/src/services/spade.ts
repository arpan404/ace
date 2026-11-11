import { dirname, join } from "node:path";
import { logFields } from "@ace/diagnostics";
import { loadToken } from "../local-files.ts";
import { SpadeHost, type SpadeHostRuntime } from "../spade/host.ts";
import type { Backoff } from "../spade/rules.ts";
import { findSpadeBinary } from "../spade/rules.ts";
import { isExecutable, nodeSpadeRuntime } from "../spade/runtime.ts";
import type { ServiceContext } from "./types.ts";

/** Test seams for the Spade host; production uses the defaults. */
export interface DaemonSpadeOptions {
  runtime?: SpadeHostRuntime;
  backoff?: Backoff;
  readyTimeoutMs?: number;
}

/**
 * Hosts Spade (ADR 0117). Spade needs the daemon's own WebSocket address, so it starts once the
 * listener is up, and runs while `spade.enabled` is on and a binary exists.
 */
export async function startSpade(context: ServiceContext): Promise<void> {
  const { config, log, services } = context;
  const options = context.options.spade ?? {};
  let daemonUrl: string | undefined;
  const host = new SpadeHost({
    dataDir: join(config.dataDir, "spade"),
    binary: () =>
      findSpadeBinary({
        env: process.env,
        runtimeDirectory: dirname(process.execPath),
        platform: process.platform,
        isExecutable,
      }),
    credentials: async () => {
      const env: Record<string, string> = {};
      if (daemonUrl) {
        env.SPADE_ACE_URL = daemonUrl;
        env.SPADE_ACE_TOKEN = loadToken(config.dataDir).token;
      }
      const mcp = services.externalMcp?.issueForSpade();
      if (mcp) {
        env.SPADE_ACE_MCP_URL = mcp.url;
        env.SPADE_ACE_MCP_TOKEN = mcp.bearer;
      } else log.log("warn", "Spade starts without ace's tools: the MCP endpoint is unavailable");
      return { env, revoke: () => mcp?.revoke() };
    },
    runtime:
      options.runtime ??
      nodeSpadeRuntime({
        env: process.env,
        now: context.now,
        output: (stream, line) =>
          log.log(
            "info",
            "spade",
            logFields([
              ["stream", stream],
              ["line", line],
            ]),
          ),
      }),
    log: (level, message, fields) =>
      log.log(level, message, fields ? logFields(Object.entries(fields)) : undefined),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
  });
  services.spade = host;
  context.resources.own(() => host.close(), "spade");
  context.onListen.push(async (server) => {
    daemonUrl = server.url;
    const settings = services.settings;
    if (!settings) return;
    const stop = await settings.subscribe(
      { keys: ["spade.enabled"], scope: {} },
      (notification) => {
        if (notification.type !== "changed") return;
        const entry = notification.entries.find((each) => each.key === "spade.enabled");
        if (entry) host.setEnabled(entry.value === true);
      },
    );
    context.resources.own(stop, "spade setting");
    host.setEnabled((await settings.get("spade.enabled")).value === true);
  });
}
