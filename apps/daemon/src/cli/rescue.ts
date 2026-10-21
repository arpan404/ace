import { z } from "zod";
import { readConfig, type Config } from "../config.ts";
import { parseArgs, type Args } from "./args.ts";
import { reportFailure } from "./failure.ts";
import { print, validateOutput } from "./io.ts";
import { CliFailure } from "./output.ts";

/**
 * `ace triage` and `ace doctor` are for when ace itself is broken: the app won't open,
 * the daemon crashed, settings are bad. They load only what they need, never connect to
 * the daemon, and never fail because some other CLI command's module can't load.
 */
export const rescueCommands = new Set(["triage", "doctor"]);

export async function rescueMain(input: string[]): Promise<void> {
  let args: Args = { words: [], flags: input.includes("--json") ? { json: true } : {} };
  try {
    args = parseArgs(input);
    await validateOutput(args);
    if (args.flags.help) {
      const { triageHelp } = await import("./triage.ts");
      await print(args, args.flags.json || args.flags.jq ? { help: triageHelp } : triageHelp);
      return;
    }
    const { config, problem } = rescueConfig(process.env);
    if (args.words[0] === "doctor") {
      const { doctorCommand } = await import("./doctor.ts");
      return await doctorCommand(args, config);
    }
    const { triageCommand } = await import("./triage.ts");
    await triageCommand(args, config, problem ? [problem] : []);
  } catch (error) {
    await reportFailure(args, error, error instanceof CliFailure ? error.outcome : "refused");
  }
}

/**
 * The normal config, or, when an ACE_* setting is invalid, the config without the bad
 * settings plus a sentence saying what was ignored. Triage must still run then.
 */
export function rescueConfig(env: NodeJS.ProcessEnv): { config: Config; problem?: string } {
  try {
    return { config: readConfig(env) };
  } catch (error) {
    const reason = settingsProblem(error);
    const { ACE_HOME, ...rest } = env;
    const others = Object.fromEntries(
      Object.entries(rest).filter(
        ([key]) => !key.startsWith("ACE_") || key.startsWith("ACE_TEST_"),
      ),
    );
    try {
      return {
        config: readConfig({ ...others, ...(ACE_HOME ? { ACE_HOME } : {}) }),
        problem: `ace's ACE_* environment settings are invalid and were ignored: ${reason}`,
      };
    } catch {
      return {
        config: readConfig(others),
        problem: `ace's ACE_* environment settings, including ACE_HOME, are invalid; used the default ace folder: ${reason}`,
      };
    }
  }
}

/** "ACE_PORT: Invalid input: expected number, received NaN" rather than raw issue JSON. */
function settingsProblem(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`)
      .join("; ");
  return error instanceof Error ? error.message.slice(0, 300) : "invalid settings";
}
