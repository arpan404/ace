import type { Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure, exitCodes, type Outcome } from "./output.ts";

/** Sets the exit code and reports a failed command on stderr, or as JSON when asked. */
export async function reportFailure(args: Args, error: unknown, outcome: Outcome): Promise<void> {
  const message = error instanceof Error ? error.message : "Command failed";
  const evidence = error instanceof CliFailure ? error.evidence : undefined;
  const failure = {
    ok: false,
    status: outcome,
    error: message,
    ...(evidence !== undefined ? { admission: evidence } : {}),
  };
  process.exitCode = exitCodes[outcome];
  if (args.flags.json || args.flags.jq || args.flags.stream === "jsonl")
    await print({ ...args, flags: { ...args.flags, jq: "", json: true } }, failure).catch(() => {
      process.stderr.write(`${JSON.stringify(failure)}\n`);
    });
  else
    process.stderr.write(
      `${message}\n${evidence === undefined ? "" : `${JSON.stringify(evidence)}\n`}`,
    );
}
