import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { JsonValue, SettingsEntry, SettingsKey, SettingsValues } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { defaults } from "@ace/settings/defaults";
import { readConfig } from "../config.ts";
import { option, type Args } from "./args.ts";
import { connectCli } from "./connection.ts";
import { CliFailure } from "./output.ts";

/** A setting as the settings service resolved it. */
export type Resolved = Pick<SettingsEntry, "value" | "provenance">;

/**
 * Global settings the way the app's Settings reads and writes them. `live` is true when a
 * running daemon took the request, so a change applies at once; otherwise the settings file
 * in the home is used, and the daemon reads it when it next starts.
 */
export interface SettingsPort {
  readonly live: boolean;
  get(key: SettingsKey): Promise<Resolved>;
  /** Many settings, in order, without flooding the settings service. */
  getMany(keys: readonly SettingsKey[]): Promise<Resolved[]>;
  /** `value` has been checked against the key's schema; both sides check it again. */
  set(key: SettingsKey, value: JsonValue): Promise<void>;
  /** Back to the default. */
  unset(key: SettingsKey): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the settings: the running daemon's over its socket, or, with no daemon running (no
 * `daemon-endpoint`, or nothing listening at it), the home's file. A daemon that runs but doesn't
 * answer (starting, busy) is never worked around: a setting saved beside it would go unseen until
 * its next restart. A remote profile has no local file to fall back to.
 */
export async function openSettings(args: Args, home: string, thing: string): Promise<SettingsPort> {
  if (option(args, "remote") || (await daemonRuns(home))) {
    let session: Awaited<ReturnType<typeof connectCli>>;
    try {
      session = await connectCli(home, args);
    } catch (error) {
      if (option(args, "remote")) throw error;
      throw new CliFailure(
        "uncertain",
        `ace's daemon is running but didn't answer, so ${thing} wasn't changed.`,
        undefined,
        { code: "uncertain", hint: "Try again once it's up (ace status)." },
      );
    }
    return daemonPort(session);
  }
  // The variables a daemon started from this shell would see.
  const overrides = readConfig().settingsOverrides;
  const service = new SettingsService({ dataDir: home, ...(overrides ? { overrides } : {}) });
  return {
    live: false,
    get: (key) => service.get(key),
    async getMany(keys) {
      const resolved: Resolved[] = [];
      // The service reads at most 32 keys at once.
      for (let start = 0; start < keys.length; start += 32) {
        const { entries } = await service.read({ keys: keys.slice(start, start + 32), scope: {} });
        resolved.push(...entries);
      }
      return resolved;
    },
    // Checked against the key's schema by the caller; the service checks it again.
    set: (key, value) => service.set(key, value as SettingsValues[typeof key], { kind: "global" }),
    unset: (key) => service.reset([key]),
    close: () => service.close(),
  };
}

function daemonPort(session: Awaited<ReturnType<typeof connectCli>>): SettingsPort {
  const { client, signal } = session;
  const write = async (key: SettingsKey, value: JsonValue) => {
    const result = await client.request(
      { type: "settings.set", key, value, layer: { kind: "global" } },
      { signal },
    );
    if (!result.ok)
      throw new CliFailure(
        "refused",
        result.diagnostics[0]?.message ?? "Changing this setting needs host administrator access.",
        undefined,
        { code: "forbidden", hint: "Run it on the machine itself, or from an admin device." },
      );
  };
  const get = async (key: SettingsKey): Promise<Resolved> => {
    const result = await client.request({ type: "settings.get", key, scope: {} }, { signal });
    const entry = result.entries.find((candidate) => candidate.key === key);
    if (!result.ok || !entry)
      throw new CliFailure(
        "uncertain",
        result.diagnostics[0]?.message ?? `The daemon didn't return ${key}.`,
      );
    return entry;
  };
  return {
    live: true,
    get,
    async getMany(keys) {
      // One at a time: the socket has no batch read, and a burst would queue behind itself.
      const resolved: Resolved[] = [];
      for (const key of keys) resolved.push(await get(key));
      return resolved;
    },
    set: write,
    // The socket has no per-key reset: the default is saved, which reads the same.
    unset: (key) => write(key, defaults[key]),
    close: () => session.close(),
  };
}

/**
 * Saves one global setting. Returns whether a running daemon took it. `beforeOffline` runs only
 * on the offline path, before the write, for work the daemon would otherwise have done
 * (registering a service, say).
 */
export async function saveGlobalSetting<K extends SettingsKey>(
  args: Args,
  home: string,
  key: K,
  value: SettingsValues[K] & JsonValue,
  thing: string,
  beforeOffline?: () => Promise<void>,
): Promise<boolean> {
  const port = await openSettings(args, home, thing);
  try {
    if (!port.live) await beforeOffline?.();
    await port.set(key, value);
    return port.live;
  } finally {
    await port.close();
  }
}

/**
 * Whether a daemon runs for this home: its `daemon-endpoint` names a port something listens on.
 * Only a missing file or a refused connection says none does; anything else counts as running.
 */
export async function daemonRuns(home: string): Promise<boolean> {
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
