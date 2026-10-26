import { runClaude } from "./claude.ts";
import { readSettings } from "./settings.ts";

/**
 * A provider CLI stand-in for daemon benchmarks: it replays checked-in recordings and never
 * calls a model. Usage: `node main.ts <provider> [provider args...]`. Only claude so far;
 * another provider adds its own protocol shell beside `claude.ts`.
 */
const [provider, ...args] = process.argv.slice(2);
const run = provider === "claude" ? runClaude : undefined;
if (!run) {
  process.stderr.write(`fake cli: unsupported provider ${provider ?? "(none)"}\n`);
  process.exit(2);
}
process.exitCode = await run(args, readSettings(process.env, provider ?? ""));
