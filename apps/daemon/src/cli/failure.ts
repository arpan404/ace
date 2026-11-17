import { cliExitCodes } from "@ace/protocol/cli-output";
import type { Args } from "./args.ts";
import { humanError, toCliError } from "./errors.ts";
import { outputMode, useColor } from "./input-mode.ts";
import { print } from "./io.ts";

/**
 * Sets the exit code and reports a failed command (ADR 0178 §4): with `--json`, one `CliError`
 * on stdout, so a caller parses one stream; otherwise its sentence and next step on stderr.
 */
export async function reportFailure(args: Args, error: unknown, command?: string): Promise<void> {
  const failure = toCliError(error, command);
  process.exitCode = cliExitCodes[failure.status];
  if (outputMode(args.flags) === "json") {
    // Never through --jq: the filter was written for the success shape.
    await print({ ...args, flags: { json: true } }, failure).catch(() => {
      process.stderr.write(`${JSON.stringify(failure)}\n`);
    });
    return;
  }
  const red = useColor(
    {
      flags: args.flags,
      env: process.env,
      stdinTTY: false,
      stdoutTTY: false,
      stderrTTY: process.stderr.isTTY === true,
    },
    "stderr",
  );
  process.stderr.write(
    humanError(failure, red ? (text) => `\u001b[31m${text}\u001b[39m` : undefined),
  );
}
