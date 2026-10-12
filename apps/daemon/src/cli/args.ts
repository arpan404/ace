export interface Args {
  words: string[];
  flags: Record<string, string | true>;
}
const switches = new Set([
  "json",
  "console",
  "tree",
  "worktree",
  "help",
  "linger",
  "include-threads",
  "follow",
  "f",
  "archive-threads",
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
    if (!value.startsWith("--") && value !== "-f") {
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
export function validateArgs(args: Args, names: readonly string[], min: number, max = min): void {
  for (const name of Object.keys(args.flags))
    if (!["json", "jq", "help", "timeout", "remote", ...names].includes(name))
      throw new Error(`Unknown option --${name}`);
  if (args.words.length < min || args.words.length > max)
    throw new Error("Invalid arguments. See ace --help.");
}
export function timeoutMs(args: Args): number {
  const value = option(args, "timeout");
  if (value === undefined) return 240_000;
  if (!/^\d+(?:ms|s|m|h)?$/.test(value))
    throw new Error("Timeout must be a positive duration, e.g. 30s");
  const suffix = value.match(/[a-z]+$/)?.[0] ?? "ms";
  const scale = suffix === "h" ? 3_600_000 : suffix === "m" ? 60_000 : suffix === "s" ? 1000 : 1;
  const result = Number.parseInt(value, 10) * scale;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 86_400_000)
    throw new Error("Timeout must be at most 24h");
  return result;
}
