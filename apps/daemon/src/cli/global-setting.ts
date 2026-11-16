import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { SettingsKey, SettingsValues } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { readConfig } from "../config.ts";
import { option, type Args } from "./args.ts";
import { connectCli } from "./connection.ts";
import { CliFailure } from "./output.ts";

/**
 * Saves a global setting the way Settings does. A running daemon gets it over its socket, so it
 * applies at once; with no daemon running (no `daemon-endpoint`, or nothing listening at it) the
 * setting is written to the home and the daemon reads it when it next starts. A daemon that runs
 * but doesn't answer (starting, busy) is never worked around: a setting saved beside it would go
 * unseen until its next restart. Returns whether a running daemon took it.
 *
 * `beforeOffline` runs only on the offline path, before the write, for work the daemon would
 * otherwise have done (registering a service, say).
 */
export async function saveGlobalSetting<K extends SettingsKey>(
  args: Args,
  home: string,
  key: K,
  value: SettingsValues[K],
  thing: string,
  beforeOffline?: () => Promise<void>,
): Promise<boolean> {
  if (option(args, "remote") || (await daemonRuns(home))) {
    let session: Awaited<ReturnType<typeof connectCli>>;
    try {
      session = await connectCli(home, args);
    } catch (error) {
      if (option(args, "remote")) throw error;
      throw new CliFailure(
        "uncertain",
        `ace's daemon is running but didn't answer, so ${thing} wasn't changed. Try again once it's up (ace status).`,
      );
    }
    try {
      const result = await session.client.request(
        { type: "settings.set", key, value, layer: { kind: "global" } },
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
    return true;
  }
  await beforeOffline?.();
  const overrides = readConfig().settingsOverrides;
  const settings = new SettingsService({ dataDir: home, ...(overrides ? { overrides } : {}) });
  try {
    await settings.set(key, value, { kind: "global" });
  } finally {
    await settings.close();
  }
  return false;
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
