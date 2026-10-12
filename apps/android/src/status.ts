import type { ThreadStatus } from "@ace/protocol";
import type { ThemeTokens } from "@ace/design-tokens";
/** Display mapping only. The daemon owns whole-tree status, including while offline. */
export function statusAppearance(status: ThreadStatus, theme: ThemeTokens) {
  switch (status.state) {
    case "needs_you":
      return {
        label: "Needs you",
        textColour: theme.statusText.needsYou,
        markerColour: theme.status.needsYou,
      };
    case "working":
      return {
        label: "Working",
        textColour: theme.statusText.working,
        markerColour: theme.status.working,
      };
    case "waiting":
      return {
        label: "Waiting",
        textColour: theme.statusText.waiting,
        markerColour: theme.status.waiting,
      };
    case "limited":
      return {
        label: "Limited",
        textColour: theme.statusText.waiting,
        markerColour: theme.status.waiting,
      };
    case "done":
      return { label: "Done", textColour: theme.statusText.done, markerColour: theme.status.done };
    case "failed":
      return {
        label: "Failed",
        textColour: theme.statusText.failed,
        markerColour: theme.status.failed,
      };
    case "unresponsive":
      return {
        label: "Unresponsive",
        textColour: theme.statusText.unresponsive,
        markerColour: theme.status.unresponsive,
      };
    case "new":
      return {
        label: "New",
        textColour: theme.colours.mutedForeground,
        markerColour: theme.colours.decoration,
      };
  }
}
