/*
 * The forge slice's lazily loaded views. They live here, not in `index.ts`, so the index stays a
 * pure list of re-exports: an index with code of its own is a real module, and the bundler then
 * loads every module it re-exports with it (the rich text renderer and parse5 joined the first
 * paint that way).
 */

/** A pull request's view in a thread's side panel tab (the panel's `pull-request` kind). */
export const loadPullRequestTab = () => import("./pr-panel-tab.tsx");
/** A pull request's whole view as a page of its own (the Pull requests page), loaded when opened. */
export const loadPrDetail = () => import("./pr-detail.tsx");
