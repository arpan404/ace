/**
 * Pages agents publish with `html_render` (ADR 0077): drawn inline in the reply, and opened at
 * full size in the thread's side panel.
 */
/** The inline page; its code loads the first time a transcript holds one (see `loaders.ts`). */
export { VisualizationItem } from "./loaders.ts";
/** The side panel's tab kind for a page. */
export { visualizationKind } from "./kind.ts";
export { visualizationTab } from "./visualization-tab.ts";
/** Which pages in a transcript keep a live frame. */
export { LiveFrames, LiveFramesContext } from "./live-frames.ts";
/**
 * The sandboxed frame itself, for a package panel's page (ADR 0200 §5.2), which reuses it with
 * its own channel, a live-frame pool of its own and the live theme.
 */
export { HtmlFrame, type PanelChannel } from "./html-frame.tsx";
export { useLiveFrame } from "./live-frames.ts";
export { useHtmlTheme } from "./page-source.ts";
