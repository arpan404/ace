import type { RowStatusTone } from "@ace/ui-core";

/**
 * The only styling the TUI draws (ADR 0176 §9): colour for state, and dim and bold ink. With
 * colour off (NO_COLOR, not a colour terminal) every function returns its text unchanged.
 */
export type StateTone = RowStatusTone;

export interface Paint {
  readonly color: boolean;
  tone(tone: StateTone, text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const toneCodes: Record<StateTone, string> = {
  "needs-you": "33",
  failed: "31",
  working: "34",
  waiting: "35",
  background: "90",
  limited: "33",
  finished: "32",
  idle: "90",
};

const plain = (text: string) => text;

export function paint(color: boolean): Paint {
  if (!color) return { color, tone: (_tone, text) => text, dim: plain, bold: plain };
  const wrap = (code: string, text: string) => (text ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    color,
    tone: (tone, text) => wrap(toneCodes[tone], text),
    dim: (text) => wrap("2", text),
    bold: (text) => wrap("1", text),
  };
}
