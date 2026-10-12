import { serviceCommand } from "@ace/service";
import { readHistoryInstances } from "../history.ts";
import { readModelInstances } from "../models.ts";
import { createDevThread, stubHandler } from "../commands.ts";
import type { Config } from "../config.ts";
import { validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
export async function runtimeCommand(args: Args, config: Config) {
  const command = args.words[0] ?? "start";
  if (command === "service") {
    validateArgs(args, [], 2, 3);
    await result(args, await serviceCommand(config.dataDir, args.words.slice(1)));
    return;
  }
  validateArgs(args, [], 0, 1);
  const development = process.env.ACE_DEV === "1";
  const { startDaemon, runDaemonProcess } = await import("../index.ts");
  const daemon = await runDaemonProcess(startDaemon, {
    config,
    handler: development ? stubHandler({ development }) : undefined,
    preview: { host: "127.0.0.1", wildcardHost: "preview.localhost", port: 0 },
    toolkits: [],
    ...(process.env.ACE_MODEL_INSTANCES !== undefined
      ? { modelInstances: readModelInstances() ?? [] }
      : {}),
    history: { instances: readHistoryInstances() },
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
