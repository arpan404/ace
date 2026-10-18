import type { ThreadStatus } from "@ace/protocol";
import type { ThemeTokens } from "@ace/design-tokens";
import { mobileStatus, type StatusDisplay, type StatusToken } from "@ace/ui-core/mobile";

/** The shared token key as this theme's colours: a status palette entry or the muted ink. */
export function tokenColours(token: StatusToken, theme: ThemeTokens) {
  if (token === "neutral")
    return { textColour: theme.colours.mutedForeground, markerColour: theme.colours.decoration };
  return { textColour: theme.statusText[token], markerColour: theme.status[token] };
}

/** A ready-made status as a pill: its shared word with this theme's colours. */
export function displayAppearance(display: StatusDisplay, theme: ThemeTokens) {
  return { label: display.label, ...tokenColours(display.token, theme) };
}

/** Display mapping only. The daemon owns whole-tree status, including while offline. */
export function statusAppearance(status: ThreadStatus, theme: ThemeTokens) {
  return displayAppearance(mobileStatus(status), theme);
}
