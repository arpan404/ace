/** A pull request's view in a thread's side panel tab (the panel's `pull-request` kind). */
export const loadPullRequestTab = () => import("./pr-panel-tab.tsx");
export { usePrSource } from "./pr-source.ts";
/** A pull request's whole view, for the Pull requests page; the panel tab loads it lazily. */
export { PrDetail } from "./pr-detail.tsx";
export { PrAvatar, PrTime } from "./pr-presentation.tsx";
export { useIssueSource } from "./issue-source.ts";
export { useOpenIssues, useOpenPullRequests, useOpenWork } from "./open-work.ts";
export type {
  PrWorkspaceExtensions,
  PrWorkspaceContext,
  PrDiffContext,
  PrListExtensions,
} from "./pr-extensions.ts";
