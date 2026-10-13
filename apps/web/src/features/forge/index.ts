/** A pull request's view in a thread's side panel tab (the panel's `pull-request` kind). */
export const loadPullRequestTab = () => import("./pr-panel-tab.tsx");
export { usePrSource } from "./pr-source.ts";
export { useIssueSource } from "./issue-source.ts";
export type {
  PrWorkspaceExtensions,
  PrWorkspaceContext,
  PrDiffContext,
  PrListExtensions,
} from "./pr-extensions.ts";
