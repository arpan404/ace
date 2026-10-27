import { accountShortLabel } from "@ace/accounts/labels";
import {
  AccountBadgeInput,
  type AccountBadgeColor,
  type AccountBadgeIcon,
} from "@ace/protocol/accounts";
/** Emoji and flags: badges draw pictures from the curated icon set, never as text. */
const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Up to two letters for an account's badge. A stored emoji badge from before the curated icon set
 * is dropped for the name's initial; unconfigured accounts use it too.
 */
export function accountBadge(label: string, shortLabel?: string | null): string {
  const value = shortLabel?.trim();
  if (value && !pictographic.test(value))
    // Made per call: native bridges load this module where Intl may arrive late.
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
      .slice(0, 2)
      .map((part) => part.segment)
      .join("");
  return accountShortLabel({ label }) ?? "?";
}

/** Why a typed badge can't be saved; nothing when it's blank (the initial) or fine. */
export function accountBadgeProblem(value: string): string | undefined {
  return !value.trim() || AccountBadgeInput.safeParse(value.trim()).success
    ? undefined
    : "Use up to two letters, or pick an icon.";
}

export interface AccountBadgeDraft {
  label: string;
  shortLabel: string;
  color?: AccountBadgeColor | undefined;
  icon?: AccountBadgeIcon | undefined;
}

/** A badge as it will look while it's edited, and what the save sends. */
export interface AccountBadgePreview {
  /** The letters drawn when no icon is chosen; "?" while the typed badge can't be used. */
  text: string;
  icon: AccountBadgeIcon | null;
  color: AccountBadgeColor;
  problem: string | null;
  save: {
    shortLabel?: string | undefined;
    badgeUsesInitial: boolean;
    badgeColor: AccountBadgeColor;
    badgeIcon: AccountBadgeIcon | null;
  };
}

export function accountBadgePreview(draft: AccountBadgeDraft): AccountBadgePreview {
  const problem = accountBadgeProblem(draft.shortLabel) ?? null;
  const typed = draft.shortLabel.trim();
  const color = draft.color ?? "neutral";
  return {
    text: problem ? "?" : accountBadge(draft.label.trim() || "Account", typed || undefined),
    icon: draft.icon ?? null,
    color,
    problem,
    save: {
      shortLabel: typed || undefined,
      badgeUsesInitial: !typed,
      badgeColor: color,
      badgeIcon: draft.icon ?? null,
    },
  };
}
