import type { Client } from "@ace/client";
import type { SettingsEntry } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { readConfig } from "../config.ts";
import { validateArgs, option, type Args } from "./args.ts";
import { connectCli } from "./connection.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import {
  configKeys,
  configName,
  configNames,
  configReport,
  configValue,
  describeConfig,
  type ConfigName,
  type ConfigReport,
} from "./config-keys.ts";

/**
 * `ace config get|set NAME [VALUE]`. A running daemon saves and applies the value at once and
 * pushes it to connected clients. With no reachable local daemon the CLI saves the same
 * settings file, which the daemon reads when it starts.
 */
export async function configCommand(args: Args, home: string): Promise<void> {
  const verb = args.words[1];
  if (verb !== "get" && verb !== "set")
    throw new CliFailure("refused", "Use ace config get [NAME] or ace config set NAME VALUE");
  if (verb === "get") validateArgs(args, [], 2, 3);
  else validateArgs(args, [], 4, 4);
  const names = args.words[2] === undefined ? configNames : [configName(args.words[2])];
  const assignment =
    verb === "set" && names[0]
      ? { name: names[0], value: configValue(names[0], args.words[3]) }
      : undefined;
  const reports = await withSettings(args, home, async (port) => {
    if (assignment) await port.set(assignment.name, assignment.value);
    return Promise.all(
      names.map(async (name) => configReport(name, await port.get(name), port.live)),
    );
  });
  await print(
    args,
    args.flags.json || option(args, "jq")
      ? reports.length === 1
        ? reports[0]
        : reports
      : reports.map((report) => describeConfig(report, assignment?.value)).join("\n"),
  );
}

interface SettingsPort {
  live: boolean;
  get(name: ConfigName): Promise<SettingsEntry>;
  set(name: ConfigName, value: number): Promise<void>;
}
async function withSettings(
  args: Args,
  home: string,
  run: (port: SettingsPort) => Promise<ConfigReport[]>,
): Promise<ConfigReport[]> {
  let session: Awaited<ReturnType<typeof connectCli>> | undefined;
  try {
    session = await connectCli(home, args);
  } catch (error) {
    // A remote host has no local file to fall back to.
    if (option(args, "remote")) throw error;
  }
  if (session) {
    try {
      return await run(daemonSettings(session.client, session.signal));
    } finally {
      await session.close();
    }
  }
  // The variables a daemon started from this shell would see.
  const overrides = readConfig().settingsOverrides;
  const service = new SettingsService({ dataDir: home, ...(overrides ? { overrides } : {}) });
  try {
    return await run({
      live: false,
      get: async (name) => service.get(configKeys[name].key),
      set: (name, value) => service.set(configKeys[name].key, value, { kind: "global" }),
    });
  } finally {
    await service.close();
  }
}
function daemonSettings(client: Client, signal: AbortSignal): SettingsPort {
  return {
    live: true,
    async get(name) {
      const result = await client.request(
        { type: "settings.get", key: configKeys[name].key, scope: {} },
        { signal },
      );
      const entry = result.entries.find((candidate) => candidate.key === configKeys[name].key);
      if (!result.ok || !entry)
        throw new CliFailure("uncertain", result.diagnostics[0]?.message ?? "Setting unavailable");
      return entry;
    },
    async set(name, value) {
      const result = await client.request(
        { type: "settings.set", key: configKeys[name].key, value, layer: { kind: "global" } },
        { signal },
      );
      if (!result.ok)
        throw new CliFailure(
          "refused",
          result.diagnostics[0]?.message ?? "Host administrator access is required",
        );
    },
  };
}
