import { setPriority } from "node:os";
import { incompatibleData } from "@ace/provider-kit/incompatible-data";
import { readAppKey } from "../app-key-input.ts";
import { readHistoryInstances } from "../history.ts";
import { readModelInstances } from "../models.ts";
import { logPriority, raiseDaemonPriority } from "../process-priority.ts";
import { createDevThread, stubHandler } from "../commands.ts";
import type { Config } from "../config.ts";
import { validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";
import { startedJson, startedText } from "./render/daemon.ts";
/** `ace start` and `ace serve` (`ace daemon start|serve`): the daemon, in the foreground. */
export async function runtimeCommand(args: Args, config: Config) {
  const command = args.words[0] ?? "start";
  validateArgs(args, [], 0, 1);
  const development = process.env.ACE_DEV === "1";
  const { startDaemon, runDaemonProcess, NewerDataError, DaemonLockHeldError } =
    await import("../index.ts");
  // Before startup, so a loaded machine schedules the startup work too.
  const priority = raiseDaemonPriority({
    platform: process.platform,
    setPriority: (value) => setPriority(value),
  });
  // The desktop app's key, when the app started this daemon (ADR 0178 §12.8): read before the
  // listener opens, so the app's first hello can prove it.
  const appKey = await readAppKey(process.env, () => process.stdin, (run, milliseconds) => {
    const timer = setTimeout(run, milliseconds);
    return () => clearTimeout(timer);
  });
  // A daemon that cannot start (for example, another one holds the lock) failed; the
  // request itself was valid, so it is not a refusal.
  const daemon = await runDaemonProcess(startDaemon, {
    config,
    ...(command === "serve"
      ? { browser: { backendPreference: async () => "headless" as const } }
      : {}),
    handler: development ? stubHandler({ development }) : undefined,
    preview: { host: "127.0.0.1", wildcardHost: "preview.localhost", port: 0 },
    ...(appKey ? { appKey } : {}),
    toolkits: [],
    ...(process.env.ACE_MODEL_INSTANCES !== undefined
      ? { modelInstances: readModelInstances() ?? [] }
      : {}),
    history: { instances: readHistoryInstances() },
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Daemon start failed";
    // Their own exit codes, so whatever started the daemon can name the port conflict, wait
    // for another daemon that holds the lock, or tell the person a newer ace uses this data.
    throw new CliFailure(
      error instanceof NewerDataError
        ? "newer-data"
        : incompatibleData(error)
          ? "incompatible-data"
          : error instanceof DaemonLockHeldError
            ? "lock-held"
            : addressInUse(error)
              ? "address-in-use"
              : "failed",
      message,
    );
  });
  if (!daemon) return;
  logPriority(priority, daemon.log);
  try {
    if (development && daemon.store.listThreads().length === 0)
      createDevThread(daemon.store, daemon.store.createWorkspace(process.cwd(), "Development"));
  } catch (error) {
    await daemon.close();
    throw error;
  }
  const started = {
    running: true as const,
    url: daemon.url,
    tokenPath: daemon.tokenPath,
    remoteUrl: daemon.remoteUrl,
    fingerprint: daemon.fingerprint,
  };
  // The desktop app, the login service and `ace chat` read these bytes: they never change.
  await result(
    args,
    args.flags.json || args.flags.jq ? startedJson(started) : startedText(started),
  );
}

/** Node's listen error for a port another process holds, however the startup wrapped it. */
function addressInUse(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 5; depth++) {
    if (Reflect.get(cause, "code") === "EADDRINUSE") return true;
    cause = cause.cause;
  }
  return false;
}
