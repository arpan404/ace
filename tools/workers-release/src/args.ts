import { environments, type Environment } from "./release.ts";

/*
 * The deploy command's arguments:
 *
 *   deploy.ts <cloud|market|all> <staging|production> [--version <tag>] [--skip-staging-check]
 */

export const workers = ["cloud", "market"] as const;
export type Worker = (typeof workers)[number];

export interface DeployArguments {
  /** In deploy order: ace cloud first, since the market checks grants against its keys. */
  workers: Worker[];
  environment: Environment;
  version: string | undefined;
  /** Production without waiting for staging to run the same release. */
  skipStagingCheck: boolean;
}

export const usage =
  "Usage: deploy.ts <cloud|market|all> <staging|production> [--version <tag>] [--skip-staging-check]";

const isWorker = (value: string): value is Worker => (workers as readonly string[]).includes(value);
const isEnvironment = (value: string): value is Environment =>
  (environments as readonly string[]).includes(value);

/** The arguments, or a message saying what's wrong with them. */
export function parseArguments(argv: readonly string[]): DeployArguments | string {
  const positional: string[] = [];
  let version: string | undefined;
  let skipStagingCheck = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--version") {
      version = argv[index + 1];
      if (!version || version.startsWith("--")) return "--version needs a tag";
      index += 1;
    } else if (argument.startsWith("--version=")) {
      version = argument.slice("--version=".length);
    } else if (argument === "--skip-staging-check") {
      skipStagingCheck = true;
    } else if (argument.startsWith("--")) {
      return `unknown option ${argument}`;
    } else {
      positional.push(argument);
    }
  }
  const [target = "", environment = "", ...extra] = positional;
  if (extra.length > 0) return `unexpected ${extra.join(" ")}`;
  if (target !== "all" && !isWorker(target)) return `unknown Worker "${target}"`;
  if (!isEnvironment(environment)) return `unknown environment "${environment}"`;
  if (skipStagingCheck && environment !== "production")
    return "--skip-staging-check only applies to production";
  return {
    workers: target === "all" ? [...workers] : [target],
    environment,
    version,
    skipStagingCheck,
  };
}
