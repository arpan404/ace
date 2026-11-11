import { z } from "zod";

/**
 * `ace update check | recover | apply [--drain | --interrupt] [--outcome]`. `--interrupt`
 * stops running agents instead of waiting (they continue after the restart); `--outcome`
 * records how it ended for the daemon, as a remote update does.
 */
export function updateArguments(args: readonly string[]) {
  const usage = "Usage: ace update check|apply [--drain|--interrupt] [--outcome]|recover";
  const command = z.enum(["check", "apply", "recover"]).parse(args[0]);
  const flags = args.slice(1);
  const known = new Set(["--drain", "--interrupt", "--outcome"]);
  if (
    (command !== "apply" && flags.length > 0) ||
    flags.some((flag) => !known.has(flag)) ||
    new Set(flags).size !== flags.length ||
    (flags.includes("--drain") && flags.includes("--interrupt"))
  )
    throw new Error(usage);
  return {
    command,
    drain: flags.includes("--drain"),
    interrupt: flags.includes("--interrupt"),
    outcome: flags.includes("--outcome"),
  };
}
