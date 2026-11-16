/*
 * A helper's words (ADR 0152): its tool, its task, its one line in the bot's conversation and
 * the sentence of an approval it asks for. Pure, and free of the fold so the fold can use it.
 */

/** The tool a bot starts a helper with. */
export const spadeHelperTool = "helper";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The task a `helper` call gave, from its arguments (or `call_tool`'s); "" when they don't say. */
export function spadeHelperTask(argumentsValue: unknown): string {
  const outer = record(argumentsValue);
  const inner = record(outer?.arguments) ?? outer;
  const task = inner?.task;
  return typeof task === "string" ? task.trim() : "";
}

/** At most `limit` characters of the first line of `text`, with "…" when cut. */
function firstLine(text: string, limit: number): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** A helper's line: what it is doing, or how it ended. `waiting`: it waits on the person. */
export function spadeHelperLine(
  helper: { task: string; outcome: "done" | "failed" | "stopped" | undefined; result: string },
  waiting: boolean,
): string {
  const task = firstLine(helper.task, 80);
  switch (helper.outcome) {
    case undefined:
      if (waiting) return task ? `Helper waiting for you: ${task}` : "Helper waiting for you";
      return task ? `Helper looking into: ${task}` : "Helper working";
    case "done": {
      const found = firstLine(helper.result, 120);
      return found ? `Helper found: ${found}` : "Helper finished";
    }
    case "failed":
      return "Helper stopped early";
    case "stopped":
      return "Helper stopped";
  }
}

/** The sentence of an approval a helper asks for: the bot's helper, and what it wants to do. */
export function spadeHelperApprovalSentence(base: string, who: string): string {
  return `A helper of ${who} wants to ${base}.`;
}
