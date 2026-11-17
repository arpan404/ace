import { z } from "zod";
import { readConfig, type Config } from "../config.ts";

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
