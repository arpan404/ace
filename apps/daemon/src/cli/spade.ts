import { betaOnAtRest } from "@ace/settings/beta";
import { cliVersion } from "../doctor/install.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { saveGlobalSetting } from "./global-setting.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * `ace spade on|off` (ADR 0123): the same switch as Settings. A running daemon applies it at
 * once: it registers or removes Spade's service and makes or retires Spade's grant. With no
 * daemon running the CLI registers or removes the service itself and saves the setting; the
 * daemon makes or retires the grant when it next starts (`saveGlobalSetting`). Refused while
 * Spade is turned off in Settings › Beta.
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
  const enabled = verb === "on";
  if (enabled && !(await betaOnAtRest(home, "spade")))
    throw new CliFailure(
      "refused",
      "Spade is turned off in Settings › Beta. Turn it on there or with ace features on spade.",
    );
  const live = await saveGlobalSetting(args, home, "spade.enabled", enabled, "Spade", async () => {
    if (enabled && (await service.state()) !== "running") {
      await service.installBinary();
      await service.register();
    }
  });
  if (!live && !enabled && (await service.state()) !== "absent") await service.remove();
  return report(args, enabled, live);
}

async function report(args: Args, enabled: boolean, live: boolean): Promise<void> {
  const words = enabled
    ? live
      ? "Spade is on."
      : "Spade is on. Its ace tools start working once the ace daemon runs."
    : "Spade is off.";
  await print(args, args.flags.json || option(args, "jq") ? { enabled, live } : words);
}
