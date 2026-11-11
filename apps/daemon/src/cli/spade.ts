import { SettingsService } from "@ace/settings";
import { readConfig } from "../config.ts";
import { spadeDisabled } from "../spade/disabled.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { connectCli } from "./connection.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * `ace spade on|off` (ADR 0123): the same switch as Settings. A running daemon applies it at
 * once: it registers or removes Spade's service and makes or retires Spade's grant. With no
 * reachable daemon the CLI registers or removes the service itself and saves the setting; the
 * daemon makes or retires the grant when it next starts.
 */
export async function spadeCommand(
  args: Args,
  home: string,
  service: SpadeServiceControl = aceSpadeService(home, process.platform),
): Promise<void> {
  const verb = args.words[1];
  if (verb !== "on" && verb !== "off") throw new CliFailure("refused", "Use ace spade on|off");
  validateArgs(args, [], 2, 2);
  if (spadeDisabled(process.env))
    throw new CliFailure("refused", "This build of ace leaves Spade out.");
  const enabled = verb === "on";
  let session: Awaited<ReturnType<typeof connectCli>> | undefined;
  try {
    session = await connectCli(home, args);
  } catch (error) {
    if (option(args, "remote")) throw error;
  }
  if (session) {
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
