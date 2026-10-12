import type { ThreadStatus } from "@ace/protocol";
import type { ThemeTokens } from "@ace/design-tokens";
/** Display mapping only. The daemon owns whole-tree status, including while offline. */
export function statusAppearance(status: ThreadStatus, theme: ThemeTokens) {
  switch (status.state) {
    case "needs_you":
      return { label: "Needs you", colour: theme.statusText.needsYou };
    case "working":
      return { label: "Working", colour: theme.statusText.working };
    case "waiting":
      return { label: "Waiting", colour: theme.statusText.waiting };
    case "limited":
      return { label: "Limited", colour: theme.statusText.waiting };
    case "done":
      return { label: "Done", colour: theme.statusText.done };
    case "failed":
      return { label: "Failed", colour: theme.statusText.failed };
    case "unresponsive":
      return { label: "Unresponsive", colour: theme.statusText.unresponsive };
    case "new":
      return { label: "New", colour: theme.colours.mutedForeground };
  }
}
