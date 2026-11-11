import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { SettingsService } from "@ace/settings";
import { readConfig } from "../config.ts";
import { spadeDisabled } from "../spade/disabled.ts";
import { cliVersion } from "../doctor/install.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { connectCli } from "./connection.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * `ace spade on|off` (ADR 0123): the same switch as Settings. A running daemon applies it at
 * once: it registers or removes Spade's service and makes or retires Spade's grant. With no
 * daemon running (no `daemon-endpoint`, or nothing listening at it) the CLI registers or removes
 * the service itself and saves the setting; the daemon makes or retires the grant when it next
 * starts. A daemon that runs but doesn't answer (starting, busy) is never worked around: the
 * setting saved beside it would go unseen until its next restart.
 */
export async function spadeCommand(
  args: Args,
  home: string,
  service: SpadeServiceControl = aceSpadeService({
    home,
    env: process.env,
    version: () => cliVersion(process.env, process.argv[1]),
    entry: process.argv[1],
  }),
): Promise<void> {
  const verb = args.words[1];
  if (verb !== "on" && verb !== "off") throw new CliFailure("refused", "Use ace spade on|off");
  validateArgs(args, [], 2, 2);
  if (spadeDisabled(process.env))
    throw new CliFailure("refused", "This build of ace leaves Spade out.");
  const enabled = verb === "on";
  if (option(args, "remote") || (await daemonRuns(home))) {
    let session: Awaited<ReturnType<typeof connectCli>>;
    try {
      session = await connectCli(home, args);
    } catch (error) {
      if (option(args, "remote")) throw error;
      throw new CliFailure(
        "uncertain",
        "ace's daemon is running but didn't answer, so Spade wasn't changed. Try again once it's up (ace status).",
      );
    }
    try {
      const result = await session.client.request(
        { type: "settings.set", key: "spade.enabled", value: enabled, layer: { kind: "global" } },
        { signal: session.signal },
      );
      if (!result.ok)
        throw new CliFailure(
          "refused",
          result.diagnostics[0]?.message ?? "Host administrator access is required",
        );
    } finally {
      await session.close();
    }
    return report(args, enabled, true);
  }
  if (enabled && (await service.state()) !== "running") {
    await service.installBinary();
    await service.register();
  }
  const overrides = readConfig().settingsOverrides;
  const settings = new SettingsService({ dataDir: home, ...(overrides ? { overrides } : {}) });
  try {
    await settings.set("spade.enabled", enabled, { kind: "global" });
  } finally {
    await settings.close();
  }
  if (!enabled && (await service.state()) !== "absent") await service.remove();
  return report(args, enabled, false);
}

async function report(args: Args, enabled: boolean, live: boolean): Promise<void> {
  const words = enabled
    ? live
      ? "Spade is on."
      : "Spade is on. Its ace tools start working once the ace daemon runs."
    : "Spade is off.";
  await print(args, args.flags.json || option(args, "jq") ? { enabled, live } : words);
}

/**
 * Whether a daemon runs for this home: its `daemon-endpoint` names a port something listens on.
 * Only a missing file or a refused connection says none does; anything else counts as running.
 */
async function daemonRuns(home: string): Promise<boolean> {
  let endpoint: URL;
  try {
    endpoint = new URL((await readFile(join(home, "daemon-endpoint"), "utf8")).trim());
  } catch (error) {
    return !(error instanceof Error && Reflect.get(error, "code") === "ENOENT");
  }
  return new Promise((resolve) => {
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve(Reflect.get(error, "code") !== "ECONNREFUSED");
    });
  });
}
