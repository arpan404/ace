/**
 * Pages agents publish with `html_render` (ADR 0077): drawn inline in the reply, and opened at
 * full size in the thread's side panel.
 */
import { lazy } from "react";

/** The inline page; its code loads the first time a transcript holds one. */
export const VisualizationItem = lazy(() =>
  import("./html-visualization.tsx").then((m) => ({ default: m.HtmlVisualizationView })),
);
/** The side panel's tab kind for a page. */
export { visualizationKind } from "./kind.ts";
export { visualizationTab } from "./visualization-tab.ts";
/** Which pages in a transcript keep a live frame. */
export { LiveFrames, LiveFramesContext } from "./live-frames.ts";
