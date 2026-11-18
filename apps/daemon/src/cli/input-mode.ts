/**
 * Who is on the other end (ADR 0178 §3, §9, §10). Pure: the dispatcher passes in the flags,
 * the environment and whether stdin and stdout are terminals.
 */
export type OutputMode = "human" | "json" | "quiet";

export interface Surroundings {
  readonly flags: Readonly<Record<string, string | true>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
}

export function outputMode(flags: Readonly<Record<string, string | true>>): OutputMode {
  if (flags.json || flags.jq !== undefined || flags.stream === "jsonl") return "json";
  if (flags.quiet) return "quiet";
  return "human";
}

/** True when `value` turns a switch-like variable on: set, and not empty, 0 or false. */
export function envOn(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no"].includes(value.trim().toLowerCase());
}

/**
 * Whether a command may ask the person anything. Never off a terminal, never in machine or
 * quiet mode, never with --no-input or ACE_NO_INPUT, and never in an agent's shell
 * (ACE_THREAD_ID), where nobody could answer.
 */
export function canPrompt(at: Surroundings): boolean {
  if (!at.stdinTTY || !at.stdoutTTY) return false;
  if (at.flags["no-input"] || outputMode(at.flags) !== "human") return false;
  if (envOn(at.env.ACE_NO_INPUT)) return false;
  if ((at.env.ACE_THREAD_ID ?? "").trim() !== "") return false;
  return true;
}

/** Colour only for state, only on a terminal, and never against NO_COLOR (§3). */
export function useColor(
  at: Surroundings & { readonly stderrTTY?: boolean },
  stream: "stdout" | "stderr" = "stdout",
): boolean {
  const choice = at.flags.color;
  if (choice === "always") return true;
  if (choice === "never") return false;
  if (outputMode(at.flags) === "json") return false;
  if (at.env.NO_COLOR !== undefined && at.env.NO_COLOR !== "") return false;
  if (envOn(at.env.FORCE_COLOR)) return true;
  return stream === "stdout" ? at.stdoutTTY : (at.stderrTTY ?? false);
}
