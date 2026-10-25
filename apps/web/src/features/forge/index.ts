/** The PR views that load when opened. Keep this file re-exports only (see `loaders.ts`). */
export { loadPullRequestTab, loadPrDetail } from "./loaders.ts";
export { usePrSource } from "./pr-source.ts";
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
export { useRepoPrOptions } from "./pr-repo-options.ts";
export { PrCompareFiles } from "./pr-compare-files.tsx";
export { readFailureText } from "./query-state.tsx";
export { ForgeCompletions, issueParticipants } from "./forge-completions.tsx";
/** People's PR and issue text drawn as GitHub draws it (ADR 0096), and the page scope it reads. */
export { ForgeProse } from "./rich/forge-prose.tsx";
export { ForgeContentScope } from "./rich/scope.ts";
export { useTaskSave } from "./rich/use-task-save.ts";
