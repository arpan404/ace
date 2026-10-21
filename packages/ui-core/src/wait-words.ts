import { pluralCount } from "./counts.ts";
import { waitingOnSubagentsLabel } from "./live-status.ts";
import type { TurnWait } from "./turn-activity.ts";

/**
 * What the composer's strip says while the main agent does nothing itself. `label` leads;
 * `code` is a single shell's command, shown as code after it; `detail` follows after a dot.
 * Pure.
 */
export interface WaitWords {
  label: string;
  code: string | undefined;
  detail: string | undefined;
}

/**
 * "Waiting for 2 subagents", with "· 1 command running" when commands it started run beside
 * them; with only commands left, "Running 2 commands" or "Running `bun run dev`", whether its
 * turn ended or was stopped. Work that isn't command-like is counted as background tasks.
 */
export function waitWords(wait: TurnWait): WaitWords {
  if (wait.kind === "subagents")
    return {
      label: waitingOnSubagentsLabel(wait.count),
      code: undefined,
      detail: wait.commands
        ? `${pluralCount(wait.commands, "command", "commands")} running`
        : undefined,
    };
  if (wait.title) return { label: "Running", code: wait.title, detail: undefined };
  const noun = wait.shells ? ["command", "commands"] : ["background task", "background tasks"];
  return {
    label: `Running ${pluralCount(wait.count, noun[0] ?? "", noun[1])}`,
    code: undefined,
    detail: undefined,
  };
}

/** The strip's words as one line, for its accessible name: "Running bun run dev". */
export function waitText(words: WaitWords): string {
  const lead = words.code ? `${words.label} ${words.code}` : words.label;
  return words.detail ? `${lead} · ${words.detail}` : lead;
}
