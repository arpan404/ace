import { globalFlagNames } from "./commands/globals.ts";
import { usageFailure } from "./output.ts";
export interface Args {
  words: string[];
  flags: Record<string, string | true>;
  /** Every value of a flag given more than once (`--keyword a --keyword b`). */
  lists?: Record<string, readonly string[]>;
  /** A person is at a terminal and may be asked (ADR 0178 §9); false for agents and pipes. */
  interactive?: boolean;
}
const switches = new Set([
  "json",
  "fix",
  "print",
  "console",
  "tree",
  "worktree",
  "help",
  // `ace --version` / `-v`: print this build's version.
  "version",
  "v",
  "linger",
  "include-threads",
  "follow",
  "f",
  "stop-threads",
  "web",
  "dry-run",
  "yes",
  // `ace clean` kind selection; one switch per storage kind.
  "threads",
  "attachments",
  "artifacts",
  "logs",
  "worktrees",
  "caches",
  "compact",
  // `ace sim`: short human output, and starting without booting.
  "human",
  "no-boot",
  // `ace thread|task wait` across several ids.
  "any",
  "all",
  // `ace market review` and `ace market appeal`/`publisher` (ADR 0174 §10).
  "by-ace",
  "not-reviewed",
  "show",
  "approve",
  "keep",
  "restore",
]);
/** Pure parsing. `--` preserves prompt text, including strings beginning with a dash. */
export function parseArgs(input: readonly string[]): Args {
  const words: string[] = [];
  const flags: Record<string, string | true> = Object.create(null);
  for (let i = input[0] === "--" ? 1 : 0; i < input.length; i++) {
    const value = input[i];
    if (value === undefined) break;
    if (value === "--") {
      words.push(...input.slice(i + 1));
      break;
    }
    if (!value.startsWith("--") && value !== "-f" && value !== "-v") {
      words.push(value);
      continue;
    }
    const [name, ...rest] = value.replace(/^--?/, "").split("=");
    if (!name || Object.hasOwn(flags, name))
      throw new Error(`Duplicate or invalid option: ${value}`);
    if (switches.has(name)) {
      if (rest.length) throw new Error(`Option --${name} takes no value`);
      flags[name] = true;
    } else {
      const next = rest.length ? rest.join("=") : input[++i];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`Missing value for --${name}`);
      flags[name] = next;
    }
  }
  return { words, flags };
}
export function option(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}
/**
 * A command module's own check of what reached it. The command table already refused unknown
 * flags and wrong argument counts with their sentences (ADR 0178); this guards the module's
 * narrower contract, as a usage error.
 */
export function validateArgs(args: Args, names: readonly string[], min: number, max = min): void {
  for (const name of Object.keys(args.flags))
    if (!globalFlagNames.has(name) && !["idempotency-key", ...names].includes(name))
      throw usageFailure(`--${name} doesn't apply here.`, {
        code: "unknown_flag",
        argument: `--${name}`,
        hint: "See its flags with --help.",
      });
  if (args.words.length < min || args.words.length > max)
    throw usageFailure(
      args.words.length < min ? "An argument is missing." : "There are too many arguments.",
      {
        code: args.words.length < min ? "missing_argument" : "too_many_arguments",
        hint: "See the command's arguments with --help.",
      },
    );
}
export function timeoutMs(args: Args): number {
  const value = option(args, "timeout");
  if (value === undefined) return 240_000;
  if (!/^\d+(?:ms|s|m|h)?$/.test(value))
    throw usageFailure("--timeout takes a duration, like 30s or 10m.", { argument: "--timeout" });
  const suffix = value.match(/[a-z]+$/)?.[0] ?? "ms";
  const scale = suffix === "h" ? 3_600_000 : suffix === "m" ? 60_000 : suffix === "s" ? 1000 : 1;
  const result = Number.parseInt(value, 10) * scale;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 86_400_000)
    throw usageFailure("--timeout can be at most 24h.", { argument: "--timeout" });
  return result;
}
