import { betaKeys, betaOnAtRest, booleanAtRest, type BetaFeature } from "@ace/settings/beta";
import { cliVersion } from "../doctor/install.ts";
import { aceSpadeService, type SpadeServiceControl } from "../spade/service-control.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { saveGlobalSetting } from "./global-setting.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

const names: Record<BetaFeature, string> = { spade: "Spade", marketplace: "The marketplace" };
const onOff = (on: boolean) => (on ? "on" : "off");
const isFeature = (word: string | undefined): word is BetaFeature =>
  word === "spade" || word === "marketplace";

/**
 * `ace features [on|off spade|marketplace]`: the switches on Settings › Beta (ADR 0139,
 * amended), saved as the global `beta.*` settings. Bare, it prints them. A running daemon applies
 * a change at once; one that isn't running reads it when it starts. Turning Spade off stops its
 * service (here, when no daemon runs) but keeps its data and its `spade.enabled` setting; turning the marketplace off keeps
 * what was installed from it.
 */
export async function featuresCommand(
  args: Args,
  home: string,
  spadeService?: SpadeServiceControl,
): Promise<void> {
  let made = spadeService;
  const service = () =>
    (made ??= aceSpadeService({
      home,
      env: process.env,
      version: () => cliVersion(process.env, process.argv[1]),
      entry: process.argv[1],
    }));
  const machine = args.flags.json === true || option(args, "jq") !== undefined;
  const verb = args.words[1];
  if (verb === undefined) {
    validateArgs(args, [], 1, 1);
    const [spade, marketplace] = await Promise.all([
      betaOnAtRest(home, "spade"),
      betaOnAtRest(home, "marketplace"),
    ]);
    if (machine) return print(args, { spade, marketplace });
    return print(args, `Spade: ${onOff(spade)}\nMarketplace: ${onOff(marketplace)}`);
  }
  const feature = args.words[2];
  if ((verb !== "on" && verb !== "off") || !isFeature(feature))
    throw new CliFailure("refused", "Use ace features on|off spade|marketplace");
  validateArgs(args, [], 3, 3);
  const on = verb === "on";
  const live = await saveGlobalSetting(args, home, betaKeys[feature], on, names[feature]);
  if (feature === "marketplace")
    return print(
      args,
      machine
        ? { marketplace: on, live }
        : on
          ? "The marketplace is turned on."
          : "The marketplace is turned off. What you installed from it keeps working.",
    );
  // A running daemon stops or starts Spade's service itself. With none, turning Spade off stops
  // the service here, as the daemon would; `spade.enabled` and Spade's data stay.
  const stopped = !on && !live && (await service().state()) !== "absent";
  if (stopped) await service().remove();
  const started = on && (await booleanAtRest(home, "spade.enabled")) === true;
  await print(
    args,
    machine
      ? { spade: on, live, stopped }
      : on
        ? started
          ? live
            ? "Spade is turned on. The ace daemon is starting it."
            : "Spade is turned on. It starts when the ace daemon next runs."
          : "Spade is turned on. Start it in Settings or with ace spade on."
        : live
          ? "Spade is turned off. The ace daemon is stopping its service; its data is kept."
          : stopped
            ? "Spade is turned off and its service was stopped. Its data is kept."
            : "Spade is turned off. Its data is kept.",
  );
}
