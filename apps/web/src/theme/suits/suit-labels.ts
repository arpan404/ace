import type { SuitLabelKey, SuitLabels } from "@ace/protocol/suit-parts";
import { emptyInboxLine } from "@ace/ui-core";
import { useSuitOnScreen } from "../theme-provider.tsx";

/*
 * Short labels a Suit may replace (ADR 0150, "Ornaments"). Each key names one fixed place and
 * the one word ace shows there by default. A Suit's label replaces that default only: whenever
 * the place shows anything else (a status such as "Waiting for your approval", a subagent wait,
 * a model's own unavailable line, Queue or Steer) ace's words stay, so a Suit can never rename a
 * status. Labels are trimmed, cut to the place's cap and stripped of control characters. Pure,
 * apart from the hook at the end.
 */

/** What ace shows in each place when the Suit says nothing. */
export const defaultLabels = {
  "composer-placeholder": "Ask anything",
  "empty-transcript": "What should we work on?",
  "empty-sidebar": emptyInboxLine,
  "working-word": "Working",
  send: "Send",
} as const satisfies Record<SuitLabelKey, string>;

/** How long each label may be, so it fits where it sits. */
export const labelCaps: Record<SuitLabelKey, number> = {
  "composer-placeholder": 40,
  "empty-transcript": 40,
  "empty-sidebar": 40,
  "working-word": 16,
  send: 12,
};

function clean(label: string, cap: number): string {
  const printable = [...label]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return [...printable].slice(0, cap).join("").trimEnd();
}

/**
 * What the place shows: `shown` (what ace would show there now), or the Suit's label when
 * `shown` is that place's default and the Suit has one.
 */
export function suitLabel(
  labels: SuitLabels | undefined,
  key: SuitLabelKey,
  shown: string,
): string {
  if (shown !== defaultLabels[key]) return shown;
  const given = labels?.[key];
  if (given === undefined) return shown;
  return clean(given, labelCaps[key]) || shown;
}

/** `suitLabel` with the Suit on screen. */
export function useSuitLabel(key: SuitLabelKey, shown: string): string {
  return suitLabel(useSuitOnScreen()?.manifest.labels, key, shown);
}
