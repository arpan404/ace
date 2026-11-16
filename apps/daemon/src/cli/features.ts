import { betaKeys, betaOnAtRest, type BetaFeature } from "@ace/settings/beta";
import { option, validateArgs, type Args } from "./args.ts";
import { saveGlobalSetting } from "./global-setting.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

const names: Record<BetaFeature, string> = { spade: "Spade", marketplace: "The marketplace" };
const isFeature = (word: string | undefined): word is BetaFeature =>
  word === "spade" || word === "marketplace";

/**
 * `ace features [on|off spade|marketplace]`: the switches on Settings › Beta (ADR 0139,
 * amended), saved as the global `beta.*` settings. Bare, it prints them. A running daemon applies
 * a change at once; one that isn't running reads it when it starts. Turning Spade off stops its
 * service but keeps its data and its `spade.enabled` setting; turning the marketplace off keeps
 * what was installed from it.
 */
export async function featuresCommand(args: Args, home: string): Promise<void> {
  const machine = args.flags.json === true || option(args, "jq") !== undefined;
  const verb = args.words[1];
  if (verb === undefined) {
    validateArgs(args, [], 1, 1);
    const [spade, marketplace] = await Promise.all([
      betaOnAtRest(home, "spade"),
      betaOnAtRest(home, "marketplace"),
    ]);
    if (machine) return print(args, { spade, marketplace });
    const word = (on: boolean) => (on ? "on" : "off");
    return print(args, `Spade: ${word(spade)}\nMarketplace: ${word(marketplace)}`);
  }
  const feature = args.words[2];
  if ((verb !== "on" && verb !== "off") || !isFeature(feature))
    throw new CliFailure("refused", "Use ace features on|off spade|marketplace");
  validateArgs(args, [], 3, 3);
  const on = verb === "on";
  await saveGlobalSetting(args, home, betaKeys[feature], on, names[feature]);
  const words =
    feature === "spade"
      ? on
        ? "Spade is turned on. Start it in Settings or with ace spade on."
        : "Spade is turned off. Its service stops; its data is kept."
      : on
        ? "The marketplace is turned on."
        : "The marketplace is turned off. What you installed from it keeps working.";
  await print(args, machine ? { [feature]: on } : words);
}
