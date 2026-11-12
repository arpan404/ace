import { loadFeatures, setSpadeShown } from "../spade/features-file.ts";
import { featuresFileName } from "../spade/features.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * `ace features [show|hide spade]` (ADR 0139): which parts of ace this machine shows, kept in
 * `features.json` in ace's home. Bare, it prints the flags. `show spade` / `hide spade` write the
 * file; a running daemon notices the change at once, and one that isn't running reads it when it
 * starts. Hiding Spade stops its service but keeps its data and its `spade.enabled` setting.
 */
export async function featuresCommand(args: Args, home: string): Promise<void> {
  const machine = args.flags.json === true || option(args, "jq") !== undefined;
  const verb = args.words[1];
  if (verb === undefined) {
    validateArgs(args, [], 1, 1);
    const read = await loadFeatures(home);
    if (machine)
      return print(args, { ...read.flags, ...(read.problem && { problem: read.problem }) });
    const lines = [`Spade: ${read.flags.spade ? "shown" : "hidden"}`];
    if (read.problem) lines.push(read.problem);
    return print(args, lines.join("\n"));
  }
  if ((verb !== "show" && verb !== "hide") || args.words[2] !== "spade")
    throw new CliFailure("refused", "Use ace features show spade or ace features hide spade");
  validateArgs(args, [], 3, 3);
  const shown = verb === "show";
  await setSpadeShown(home, shown);
  const words = shown
    ? "Spade is shown. Turn it on in Settings or with ace spade on."
    : "Spade is hidden. Its service stops; its data is kept.";
  await print(args, machine ? { spade: shown, file: featuresFileName } : words);
}
