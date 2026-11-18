import type { RowStatusIconKind, RowStatusTone } from "@ace/ui-core";
import { formatAge, formatSpan } from "@ace/ui-core/time";

/**
 * One glyph per status, in its state's colour only on a terminal (ADR 0178 §3): `◆` approval,
 * `?` question, `✦` model choice (all needs-you amber), `✕` failed, `◌` working with its
 * running time, `◌3` waiting on three agents, `▣` background, `✓` finished unseen, and nothing
 * for idle, just the age. Pure.
 */
const glyphs: Record<RowStatusIconKind | "none", string> = {
  approve: "◆",
  question: "?",
  model: "✦",
  failed: "✕",
  working: "◌",
  agents: "◌",
  waiting: "◌",
  background: "▣",
  limited: "◷",
  done: "✓",
  none: "",
};

/** ANSI colours for state, the only colour the CLI uses. Idle has none. */
const colours: Record<RowStatusTone, string | undefined> = {
  "needs-you": "33",
  failed: "31",
  working: "36",
  waiting: "36",
  background: "35",
  limited: "33",
  finished: "32",
  idle: undefined,
};

export function paint(text: string, tone: RowStatusTone, colour: boolean): string {
  const code = colours[tone];
  return colour && code && text ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export interface StatusMark {
  readonly icon: RowStatusIconKind | "none";
  readonly tone: RowStatusTone;
  readonly waitingOn?: number | undefined;
  readonly since?: number | undefined;
  readonly activityAt: number;
}

/** The glyph alone, with its count for `◌3`. */
export function glyph(mark: Pick<StatusMark, "icon" | "waitingOn">): string {
  const base = glyphs[mark.icon];
  return mark.icon === "agents" && mark.waitingOn ? `${base}${mark.waitingOn}` : base;
}

/**
 * The status cell: the glyph, then the running time while it works or waits, else the age. A
 * needs-you, failed or finished row shows its glyph alone.
 */
export function statusCell(
  mark: StatusMark,
  now: number,
  colour: boolean,
): { text: string; width: number } {
  const symbol = glyph(mark);
  const loud = ["approve", "question", "model", "done"].includes(mark.icon);
  const unreadFailure = mark.icon === "failed" && mark.tone === "failed";
  const time =
    loud || unreadFailure
      ? ""
      : mark.since !== undefined
        ? formatSpan(mark.since, now)
        : formatAge(mark.activityAt, now);
  const plain = [symbol, time].filter(Boolean).join(" ");
  const painted = [paint(symbol, mark.tone, colour), time].filter(Boolean).join(" ");
  return { text: painted, width: Array.from(plain).length };
}
