import { join } from "node:path";
import { DEFAULT_LOG_MAX_BYTES, createFileSink, logFields } from "@ace/diagnostics";
import type { RedactionContext } from "@ace/redaction";
import { createDaemonLogger } from "./diagnostic-log.ts";
import type { Config } from "./config.ts";

/** `ACE_HOME/logs`, where the daemon's `ace.jsonl` records live. */
export function daemonLogDirectory(config: Config): string {
  return join(config.dataDir, "logs");
}

/** The daemon's file log. A failed sink keeps the daemon running and counts failed writes. */
export async function openDaemonLog(config: Config, context: RedactionContext, now: () => number) {
  // Starts at the environment or default cap; the settings service applies the saved cap.
  const sink = await createFileSink({
    directory: daemonLogDirectory(config),
    totalBytes: config.settingsOverrides?.["logs.maxBytes"] ?? DEFAULT_LOG_MAX_BYTES,
    context,
  }).catch(() => ({
    async write() {
      throw new Error("File logging unavailable");
    },
    async close() {},
  }));
  return createDaemonLogger({ sink, now, level: config.logLevel }, context);
}

/** Identifies which binary wrote a record, so restarts from different builds can be told apart. */
export function buildFields(
  env: NodeJS.ProcessEnv,
  pid: number,
  dataFormat: string,
): (readonly [string, unknown])[] {
  return [
    ["pid", pid],
    ["version", env.ACE_VERSION ?? "development"],
    ...(env.ACE_COMMIT ? [["commit", env.ACE_COMMIT] as const] : []),
    ["dataFormat", dataFormat],
  ];
}

/** Records one error in the daemon log without starting the daemon (a refused start). */
export async function logStartupRefusal(
  config: Config,
  context: RedactionContext,
  now: () => number,
  message: string,
  fields: (readonly [string, unknown])[],
): Promise<void> {
  const log = await openDaemonLog(config, context, now);
  log.log("error", message, logFields(fields));
  await log.close();
}
