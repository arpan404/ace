import { ShapesIcon } from "@phosphor-icons/react";
import { defineTabKind } from "@/lib/workspace/index.ts";
import { visualizationTabData, visualizationTabKind } from "./visualization-tab.ts";

/**
 * A published page beside the conversation (id: the page's content hash), opened from the page's
 * Open in side panel. Not in the launcher: a page only opens from the reply that holds it.
 */
export const visualizationKind = defineTabKind({
  kind: visualizationTabKind,
  label: "Visualization",
  icon: ShapesIcon,
  title: (tab) => visualizationTabData(tab)?.title ?? tab.title ?? "Visualization",
  load: () =>
    import("./panel-view.tsx").then((m) => ({
      default: m.default,
      Actions: m.VisualizationActions,
    })),
});
