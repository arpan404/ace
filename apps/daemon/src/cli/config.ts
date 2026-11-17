import { readFile } from "node:fs/promises";
import type { CliConfigEntry } from "@ace/protocol/cli-outputs";
import type { SettingsKey } from "@ace/protocol";
import type { SpadeServiceControl } from "../spade/service-control.ts";
import type { Args } from "./args.ts";
import { configEntry, configKeys, parseConfigValue, resolveConfigKey } from "./config-keys.ts";
import { switchFeature } from "./features.ts";
import { openSettings, type SettingsPort } from "./global-setting.ts";
import { switchSpade } from "./spade.ts";

/**
 * `ace config list|get|set|unset` (ADR 0176 §7) over every global setting. A running daemon
 * saves and applies a value at once and pushes it to connected clients. With no daemon running
 * the CLI saves the same settings file, which the daemon reads when it starts.
 */

async function withPort<T>(
  args: Args,
  home: string,
  thing: string,
  run: (port: SettingsPort) => Promise<T>,
): Promise<T> {
  const port = await openSettings(args, home, thing);
  try {
    return await run(port);
  } finally {
    await port.close();
  }
}

export function configList(args: Args, home: string): Promise<CliConfigEntry[]> {
  return withPort(args, home, "the settings", async (port) => {
    const resolved = await port.getMany(configKeys.map((entry) => entry.key));
    return configKeys.flatMap((entry, index) => {
      const value = resolved[index];
      return value ? [configEntry(entry.key, entry, value, port.live)] : [];
    });
  });
}

export function configGet(args: Args, home: string, name: string): Promise<CliConfigEntry> {
  const entry = resolveConfigKey(name);
  return withPort(args, home, name, async (port) =>
    configEntry(name, entry, await port.get(entry.key), port.live),
  );
}

/** The switches with their own command keep their own effects (Spade's service, say). */
const switchKeys: ReadonlySet<SettingsKey> = new Set([
  "spade.enabled",
  "beta.spade",
  "beta.marketplace",
]);

export async function configSet(
  args: Args,
  home: string,
  name: string,
  raw: string | undefined,
  spade: () => SpadeServiceControl,
): Promise<CliConfigEntry> {
  const entry = resolveConfigKey(name);
  // `unset` passes no value: the default.
  const value =
    raw === undefined
      ? undefined
      : await parseConfigValue(entry, name, raw, (path) => readFile(path, "utf8"));
  if (switchKeys.has(entry.key)) {
    const { defaults } = await import("@ace/settings/defaults");
    const on = (value ?? defaults[entry.key]) === true;
    if (entry.key === "spade.enabled") await switchSpade(args, home, on, spade());
    else
      await switchFeature(
        args,
        home,
        entry.key === "beta.spade" ? "spade" : "marketplace",
        on,
        spade,
      );
    return configGet(args, home, name);
  }
  return withPort(args, home, name, async (port) => {
    if (value === undefined) await port.unset(entry.key);
    else await port.set(entry.key, value);
    return configEntry(name, entry, await port.get(entry.key), port.live);
  });
}
