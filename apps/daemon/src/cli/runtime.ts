import { serviceCommand } from "@ace/service";
import { readHistoryInstances } from "../history.ts";
import { readModelInstances } from "../models.ts";
import { createDevThread, stubHandler } from "../commands.ts";
import type { Config } from "../config.ts";
import { validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function runtimeCommand(args: Args, config: Config) {
  const command = args.words[0] ?? "start";
  if (command === "service") {
    validateArgs(args, ["linger"], 2, 3);
    await result(
      args,
      await serviceCommand(config.dataDir, [
        ...args.words.slice(1),
        ...(args.flags.linger ? ["--linger"] : []),
      ]),
    );
    return;
  }
  validateArgs(args, [], 0, 1);
  const development = process.env.ACE_DEV === "1";
  const { startDaemon, runDaemonProcess } = await import("../index.ts");
  // A daemon that cannot start (for example, another one holds the lock) failed; the
  // request itself was valid, so it is not a refusal.
  const daemon = await runDaemonProcess(startDaemon, {
    config,
    ...(command === "serve"
      ? { browser: { backendPreference: async () => "headless" as const } }
      : {}),
    handler: development ? stubHandler({ development }) : undefined,
    preview: { host: "127.0.0.1", wildcardHost: "preview.localhost", port: 0 },
    toolkits: [],
    ...(process.env.ACE_MODEL_INSTANCES !== undefined
      ? { modelInstances: readModelInstances() ?? [] }
      : {}),
    history: { instances: readHistoryInstances() },
  }).catch((error: unknown) => {
    throw new CliFailure("failed", error instanceof Error ? error.message : "Daemon start failed");
  });
  if (!daemon) return;
  try {
    if (development && daemon.store.listThreads().length === 0)
      createDevThread(daemon.store, daemon.store.createWorkspace(process.cwd(), "Development"));
  } catch (error) {
    await daemon.close();
    throw error;
  }
  await result(
    args,
    args.flags.json || args.flags.jq
      ? {
          running: true,
          url: daemon.url,
          tokenPath: daemon.tokenPath,
          remoteUrl: daemon.remoteUrl,
          fingerprint: daemon.fingerprint,
        }
      : `ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}${daemon.remoteUrl ? `\nRemote: ${daemon.remoteUrl}\nPublic-key SHA-256: ${daemon.fingerprint}` : ""}`,
  );
}
