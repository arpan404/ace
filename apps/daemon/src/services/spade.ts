import { dirname, join } from "node:path";
import { logFields } from "@ace/diagnostics";
import { SpadeHost, type SpadeHostRuntime } from "../spade/host.ts";
import type { Backoff } from "../spade/rules.ts";
import { findSpadeBinary } from "../spade/rules.ts";
import { isExecutable, nodeSpadeRuntime } from "../spade/runtime.ts";
import { spadeCredentials } from "./spade-credentials.ts";
import type { ServiceContext } from "./types.ts";

/** Test seams for the Spade host; production uses the defaults. */
export interface DaemonSpadeOptions {
  /** The environment Spade's binary is looked up in and inherits; the daemon's by default. */
  env?: NodeJS.ProcessEnv;
  runtime?: SpadeHostRuntime;
  backoff?: Backoff;
  readyTimeoutMs?: number;
}

/**
 * Hosts Spade (ADR 0121). Spade needs the daemon's own WebSocket address, so it starts once the
 * listener is up, and runs while `spade.enabled` is on and a binary exists.
 */
export async function startSpade(context: ServiceContext): Promise<void> {
  const { config, log, services } = context;
  const options = context.options.spade ?? {};
  const env = options.env ?? process.env;
  const disabled = spadeDisabled(env);
  let daemonUrl: string | undefined;
  const dataDir = join(config.dataDir, "spade");
  // Bound once the host exists: credentials report the host thread through it.
  let credentials: (() => Promise<import("../spade/host.ts").SpadeCredentials>) | undefined;
  const host = new SpadeHost({
    dataDir,
    binary: () =>
      findSpadeBinary({
        env,
        runtimeDirectory: dirname(process.execPath),
        platform: process.platform,
        isExecutable,
      }),
    credentials: () =>
      credentials?.() ?? Promise.reject(new Error("Spade's credentials are not ready")),
    runtime:
      options.runtime ??
      nodeSpadeRuntime({
        env,
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
  credentials = spadeCredentials(context, host, dataDir, () => daemonUrl);
  services.spade = host;
  context.resources.own(() => host.close(), "spade");
  context.onListen.push(async (server) => {
    daemonUrl = server.url;
    const settings = services.settings;
    // Left out of this build: Spade stays off whatever the setting says.
    if (!settings || disabled) return;
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

/**
 * Whether Spade is left out: built with `DISABLE_SPADE=1` (the release bundle bakes it in) or
 * started with `DISABLE_SPADE=1` in the daemon's environment.
 */
export function spadeDisabled(env: Record<string, string | undefined>): boolean {
  return process.env.ACE_BUILD_DISABLE_SPADE === "1" || env.DISABLE_SPADE === "1";
}
