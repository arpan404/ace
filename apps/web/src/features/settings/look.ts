import type { SuitId, SuitSummary } from "@ace/protocol/suits";
import { themes, type ThemeId } from "@ace/themes";
import { useCallback } from "react";
import { suitReady, wantedSuit } from "@/theme/suits/applied-suit.ts";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";

/*
 * Which look the Appearance page shows as picked (a built-in theme or a Suit, ADR 0150), and
 * the one quiet line when that isn't simply what's on screen. An agent's preview counts as the
 * pick while it runs. Pure; `useLook` wires it to the page.
 */

export interface LookInputs {
  setting: SuitId | null;
  preview: SuitId | null | undefined;
  suitsOff: boolean;
  summaries: readonly SuitSummary[] | undefined;
  themeName: string;
}

export interface Look {
  /** The Suit picked, or null when a theme card is. */
  suitId: SuitId | null;
  /** Its listing, once the library has answered. */
  summary: SuitSummary | undefined;
  /** Why what's picked isn't what shows, when it isn't. */
  note: string | undefined;
}

export function lookFor(inputs: LookInputs): Look {
  const { summaries, themeName } = inputs;
  if (inputs.suitsOff) {
    return {
      suitId: null,
      summary: undefined,
      note: `Custom looks are off for this session, so ${themeName} shows.`,
    };
  }
  const wanted = wantedSuit(inputs.setting, inputs.preview);
  if (wanted === null) return { suitId: null, summary: undefined, note: undefined };
  // Until the library answers, the picked Suit holds its place (the boot cache shows it).
  if (summaries === undefined) return { suitId: wanted, summary: undefined, note: undefined };
  const summary = summaries.find((entry) => entry.id === wanted);
  if (!summary) return { suitId: null, summary: undefined, note: undefined };
  if (!suitReady(summary))
    return { suitId: null, summary, note: `${summary.name} needs fixes, so ${themeName} shows.` };
  return { suitId: wanted, summary, note: undefined };
}

export type LookChoice = { theme: ThemeId } | { suit: SuitId };

export function useLook(): Look & { pick(choice: LookChoice): void } {
  const { appearance, update, suitsOff } = useTheme();
  const { summaries, preview, revertPreview } = useSuitLibrary();
  const look = lookFor({
    setting: appearance.suit,
    preview,
    suitsOff,
    summaries,
    themeName: themes[appearance.theme].name,
  });
  // Picking ends an agent's preview here, or the pick would hide under it.
  const pick = useCallback(
    (choice: LookChoice) => {
      revertPreview();
      update("theme" in choice ? { theme: choice.theme, suit: null } : { suit: choice.suit });
    },
    [revertPreview, update],
  );
  return { ...look, pick };
}
