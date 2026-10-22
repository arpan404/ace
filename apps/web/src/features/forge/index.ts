/** A pull request's view in a thread's side panel tab (the panel's `pull-request` kind). */
export const loadPullRequestTab = () => import("./pr-panel-tab.tsx");
export { usePrSource } from "./pr-source.ts";
/** A pull request's whole view as a page of its own (the Pull requests page), loaded when opened. */
export const loadPrDetail = () => import("./pr-detail.tsx");
export { useIssueSource } from "./issue-source.ts";
export { useOpenIssues, useOpenPullRequests, useOpenWork } from "./open-work.ts";
export { useMergeMethod } from "./pr-merge-method.ts";
export { PrCheckLog } from "./pr-check-log.tsx";
export { PrPageSkeleton, type PrSeed } from "./pr-page-skeleton.tsx";
export type {
  PrWorkspaceExtensions,
  PrWorkspaceContext,
  PrDiffContext,
  PrListExtensions,
} from "./pr-extensions.ts";
/** People's PR and issue text drawn as GitHub draws it (ADR 0096), and the page scope it reads. */
export { ForgeProse } from "./rich/forge-prose.tsx";
export { ForgeContentScope } from "./rich/scope.ts";
export { useTaskSave } from "./rich/use-task-save.ts";
