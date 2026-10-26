/*
 * Kept out of `index.ts` so the index stays a pure list of re-exports: an index with code of its
 * own is a real module, and the bundler then loads every module it re-exports with it.
 */
import { lazy } from "react";

/** The inline page; its code loads the first time a transcript holds one. */
export const VisualizationItem = lazy(() =>
  import("./html-visualization.tsx").then((m) => ({ default: m.HtmlVisualizationView })),
);
