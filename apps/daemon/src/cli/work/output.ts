import type { Args } from "../args.ts";
import { useColor } from "../input-mode.ts";
import { emit, type Renderer } from "../io.ts";
import { CliFailure, exitCodes, type Outcome } from "../output.ts";
import type { CommandContext } from "../run/context.ts";

/** Whether this run paints state colours on stdout (ADR 0178 §3). */
export function colourOn(context: Pick<CommandContext, "args" | "env">): boolean {
  return useColor({
    flags: context.args.flags,
    env: context.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  });
}

/** The terminal's width, when stdout is one; off a terminal nothing is cut. */
export function terminalWidth(): number | undefined {
  return process.stdout.isTTY === true ? process.stdout.columns : undefined;
}

/** A read's result in the mode asked for, and the exit code its outcome names. */
export async function show<T>(
  args: Args,
  value: T,
  render: Renderer<T>,
  outcome: Outcome = "ok",
): Promise<void> {
  await emit(args, value, render);
  process.exitCode = exitCodes[outcome];
}

/**
 * A mutation's receipt. Actions print nothing with `--quiet`; if printing fails after the
 * daemon took it, the outcome is uncertain and the retry key is named.
 */
export async function receipt<T extends { idempotencyKey?: string }>(
  args: Args,
  value: T,
  human: (value: T) => string | readonly string[],
): Promise<void> {
  try {
    await emit(args, value, { human, quiet: () => [] });
    process.exitCode = 0;
  } catch {
    throw new CliFailure(
      "uncertain",
      "ace took it, but the answer couldn't be printed.",
      value,
      value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {},
    );
  }
}

/** `--limit N` within 1..max, or the default. */
export function limitFlag(args: Args, fallback: number, max: number): number {
  const value = args.flags.limit;
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(number >= 1 && number <= max))
    throw new CliFailure("usage", `--limit takes a number from 1 to ${max}.`, undefined, {
      code: "bad_argument",
      argument: "--limit",
    });
  return number;
}

export function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}
