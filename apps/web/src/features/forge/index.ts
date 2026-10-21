/** A pull request's view in a thread's side panel tab (the panel's `pull-request` kind). */
export const loadPullRequestTab = () => import("./pr-panel-tab.tsx");
export { usePrSource } from "./pr-source.ts";
/** A pull request's whole view as a page of its own (the Pull requests page), loaded when opened. */
export const loadPrDetail = () => import("./pr-detail.tsx");
export { useIssueSource } from "./issue-source.ts";
export { useOpenIssues, useOpenPullRequests, useOpenWork } from "./open-work.ts";
export type {
  PrWorkspaceExtensions,
  PrWorkspaceContext,
  PrDiffContext,
  PrListExtensions,
} from "./pr-extensions.ts";
