import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type ProviderKind } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DiffIcon,
  EllipsisIcon,
  LoaderIcon,
  RotateCwIcon,
  SparklesIcon,
} from "lucide-react";

import {
  type GeneratedWorkspaceSummary,
  summarizeActivePlan,
  type ActivePlanState,
  type LatestProposedPlanState,
} from "../session-logic";
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const diffCountFormatter = new Intl.NumberFormat();

function stepStatusIcon(status: string) {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

interface PlanSummaryPanelProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  generatedWorkspaceSummary: GeneratedWorkspaceSummary | null;
  activeProvider?: ProviderKind | null;
  markdownCwd: string | undefined;
  onOpenDiffPanel?: (() => void) | null;
  onRegenerateSummary?: (() => Promise<void> | void) | null;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
  enableLocalFileLinks?: boolean;
  workspaceDiffSummary: {
    additions: number;
    deletions: number;
    fileCount: number;
  } | null;
  workspaceRoot: string | undefined;
}

type WorkspaceDiffSummary = NonNullable<PlanSummaryPanelProps["workspaceDiffSummary"]>;

function formatDiffCount(value: number) {
  return diffCountFormatter.format(value);
}

function formatPlanProgressValue(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function getDisplaySteps(
  steps: ReadonlyArray<ActivePlanState["steps"][number]>,
): ActivePlanState["steps"] {
  let activeStepSeen = false;

  return steps.map((step) => {
    if (step.status !== "inProgress") {
      return step;
    }
    if (!activeStepSeen) {
      activeStepSeen = true;
      return step;
    }
    return {
      ...step,
      status: "pending",
    };
  });
}

function summaryGeneratedAfterRequest(summaryCreatedAt: string | null, requestedAt: string | null) {
  if (!summaryCreatedAt || !requestedAt) {
    return false;
  }
  const summaryTime = Date.parse(summaryCreatedAt);
  const requestTime = Date.parse(requestedAt);
  return Number.isFinite(summaryTime) && Number.isFinite(requestTime) && summaryTime >= requestTime;
}

function SummaryGenerationNotice({ hasExistingSummary }: { hasExistingSummary: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs text-blue-300" role="status">
      <Spinner aria-hidden="true" className="size-3.5 text-blue-300" role="presentation" />
      <span>{hasExistingSummary ? "Updating summary..." : "Generating summary..."}</span>
    </div>
  );
}

function DiffSummaryOverview({
  workspaceDiffSummary,
  actions,
}: {
  workspaceDiffSummary: WorkspaceDiffSummary;
  actions: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Diff summary</p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Current working tree changes ready for review.
          </p>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="inline-flex items-baseline gap-x-1.5">
            <span className="font-semibold tabular-nums text-success">
              +{formatDiffCount(workspaceDiffSummary.additions)}
            </span>
            <span className="tabular-nums">/</span>
            <span className="font-semibold tabular-nums text-destructive">
              -{formatDiffCount(workspaceDiffSummary.deletions)}
            </span>
          </span>
          <span>changes across</span>
          <span className="inline-flex items-baseline gap-x-1">
            <span className="tabular-nums">{formatDiffCount(workspaceDiffSummary.fileCount)}</span>
            <span>{workspaceDiffSummary.fileCount === 1 ? "file" : "files"}</span>
          </span>
        </span>
      </p>
    </div>
  );
}

export const PlanSummaryPanel = memo(function PlanSummaryPanel({
  activePlan,
  activeProposedPlan,
  generatedWorkspaceSummary,
  markdownCwd,
  onOpenDiffPanel = null,
  onRegenerateSummary = null,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  enableLocalFileLinks = true,
  workspaceDiffSummary,
  workspaceRoot,
}: PlanSummaryPanelProps) {
  const [summaryDetailsExpanded, setSummaryDetailsExpanded] = useState(true);
  const [planDetailsExpanded, setPlanDetailsExpanded] = useState(true);
  const [todoDetailsExpanded, setTodoDetailsExpanded] = useState(true);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);
  const [summaryRequestStartedAt, setSummaryRequestStartedAt] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const effectivePlan = activePlan;
  const effectivePlanMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = effectivePlanMarkdown
    ? stripDisplayedPlanMarkdown(effectivePlanMarkdown)
    : null;
  const planTitle = effectivePlanMarkdown ? proposedPlanTitle(effectivePlanMarkdown) : null;
  const planProgress = useMemo(() => summarizeActivePlan(effectivePlan), [effectivePlan]);
  const displaySteps = useMemo(
    () => getDisplaySteps(effectivePlan?.steps ?? []),
    [effectivePlan?.steps],
  );
  const hasActionableTodo = planProgress?.currentIndex !== null;
  const progressDigits = planProgress ? Math.max(2, String(planProgress.total).length) : 2;
  const completedPercent = planProgress
    ? Math.round((planProgress.completed / Math.max(planProgress.total, 1)) * 100)
    : 0;
  const generatedWorkspaceSummaryCreatedAt = generatedWorkspaceSummary?.createdAt ?? null;

  useEffect(() => {
    if (
      isRegeneratingSummary &&
      summaryGeneratedAfterRequest(generatedWorkspaceSummaryCreatedAt, summaryRequestStartedAt)
    ) {
      setIsRegeneratingSummary(false);
      setSummaryRequestStartedAt(null);
    }
  }, [generatedWorkspaceSummaryCreatedAt, isRegeneratingSummary, summaryRequestStartedAt]);

  useEffect(() => {
    if (!isRegeneratingSummary) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setIsRegeneratingSummary(false);
      setSummaryRequestStartedAt(null);
    }, 90_000);
    return () => window.clearTimeout(timeout);
  }, [isRegeneratingSummary]);

  const handleCopyPlan = useCallback(() => {
    if (!effectivePlanMarkdown) return;
    copyToClipboard(effectivePlanMarkdown);
  }, [copyToClipboard, effectivePlanMarkdown]);

  const handleDownload = useCallback(() => {
    if (!effectivePlanMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(effectivePlanMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(effectivePlanMarkdown));
  }, [effectivePlanMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !effectivePlanMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(effectivePlanMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(effectivePlanMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [effectivePlanMarkdown, workspaceRoot]);

  const handleRegenerateSummary = useCallback(() => {
    if (!onRegenerateSummary || isRegeneratingSummary) {
      return;
    }

    const requestStartedAt = new Date().toISOString();
    setSummaryRequestStartedAt(requestStartedAt);
    setIsRegeneratingSummary(true);
    void Promise.resolve(onRegenerateSummary()).catch((error: unknown) => {
      setSummaryRequestStartedAt(null);
      setIsRegeneratingSummary(false);
      toastManager.add({
        type: "error",
        title: "Could not regenerate summary",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [isRegeneratingSummary, onRegenerateSummary]);

  const hasTodoSection = Boolean(effectivePlan && effectivePlan.steps.length > 0);
  const todoPlan = hasTodoSection ? effectivePlan : null;
  const hasAnyContent = Boolean(
    generatedWorkspaceSummary ||
    workspaceDiffSummary ||
    effectivePlanMarkdown ||
    hasTodoSection ||
    onRegenerateSummary,
  );
  const regenerateSummaryLabel = generatedWorkspaceSummary
    ? "Regenerate summary"
    : "Generate summary";
  const regenerateSummaryTooltipLabel = isRegeneratingSummary
    ? "Generating summary"
    : regenerateSummaryLabel;
  const regenerateSummaryButton = onRegenerateSummary ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={handleRegenerateSummary}
            disabled={isRegeneratingSummary}
            aria-busy={isRegeneratingSummary}
            aria-label={regenerateSummaryLabel}
          />
        }
      >
        {isRegeneratingSummary ? (
          <Spinner className="size-3.5" />
        ) : (
          <>
            {generatedWorkspaceSummary ? (
              <RotateCwIcon className="size-3" />
            ) : (
              <SparklesIcon className="size-3" />
            )}
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{regenerateSummaryTooltipLabel}</TooltipPopup>
    </Tooltip>
  ) : null;
  const hasDiffSummaryActions = Boolean(regenerateSummaryButton || onOpenDiffPanel);
  const diffSummaryActions = hasDiffSummaryActions ? (
    <>
      {regenerateSummaryButton}
      {onOpenDiffPanel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={onOpenDiffPanel}
                aria-label="Open review"
              />
            }
          >
            <DiffIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open review</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden p-4">
      <section className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-plan-summary-scroll-container="true"
        >
          <div className="flex min-h-full flex-col gap-6 px-4 py-4 sm:px-5">
            {!hasAnyContent ? null : (
              <>
                {generatedWorkspaceSummary ? (
                  <div className="space-y-4">
                    {workspaceDiffSummary ? (
                      <DiffSummaryOverview
                        workspaceDiffSummary={workspaceDiffSummary}
                        actions={diffSummaryActions}
                      />
                    ) : null}
                    <div>
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          className="group inline-flex min-w-0 items-center gap-2 rounded-sm"
                          onClick={() => setSummaryDetailsExpanded((value) => !value)}
                          aria-expanded={summaryDetailsExpanded}
                          aria-label={
                            summaryDetailsExpanded
                              ? "Collapse summary details"
                              : "Expand summary details"
                          }
                        >
                          {summaryDetailsExpanded ? (
                            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                          ) : (
                            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                          )}
                          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                            Summary
                          </span>
                        </button>
                        {!workspaceDiffSummary ? regenerateSummaryButton : null}
                      </div>
                      {isRegeneratingSummary ? (
                        <div className="mt-3">
                          <SummaryGenerationNotice hasExistingSummary={true} />
                        </div>
                      ) : null}
                      {summaryDetailsExpanded ? (
                        <div className="mt-4 pb-1 pt-1">
                          <ChatMarkdown
                            text={generatedWorkspaceSummary.markdown}
                            cwd={markdownCwd}
                            isStreaming={false}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenFilePath={onOpenFilePath}
                            enableLocalFileLinks={enableLocalFileLinks}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {workspaceDiffSummary && !generatedWorkspaceSummary ? (
                  <div className="space-y-4">
                    <DiffSummaryOverview
                      workspaceDiffSummary={workspaceDiffSummary}
                      actions={diffSummaryActions}
                    />
                    {isRegeneratingSummary ? (
                      <SummaryGenerationNotice hasExistingSummary={false} />
                    ) : null}
                  </div>
                ) : null}

                {!generatedWorkspaceSummary && !workspaceDiffSummary ? (
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                          Changes
                        </p>
                        <p className="text-sm font-semibold text-foreground">No changes</p>
                        <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                          There are no uncommitted code changes.
                        </p>
                      </div>
                      {regenerateSummaryButton ? (
                        <div className="flex items-center gap-2">{regenerateSummaryButton}</div>
                      ) : null}
                    </div>
                    {isRegeneratingSummary ? (
                      <div className="mt-3">
                        <SummaryGenerationNotice hasExistingSummary={false} />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {effectivePlanMarkdown ? (
                  <div
                    className={
                      generatedWorkspaceSummary || workspaceDiffSummary
                        ? "border-t border-border/60 pt-6"
                        : undefined
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                          Plan
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="group inline-flex items-center gap-1.5 rounded-sm text-sm font-medium tracking-tight text-foreground"
                            onClick={() => setPlanDetailsExpanded((value) => !value)}
                            aria-expanded={planDetailsExpanded}
                            aria-label={
                              planDetailsExpanded ? "Collapse plan details" : "Expand plan details"
                            }
                          >
                            {planDetailsExpanded ? (
                              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                            ) : (
                              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                            )}
                            <span>{planTitle ?? "Proposed plan"}</span>
                          </button>
                        </div>
                      </div>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              className="text-muted-foreground hover:text-foreground"
                              aria-label="Plan actions"
                            />
                          }
                        >
                          <EllipsisIcon className="size-3.5" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={handleCopyPlan}>
                            {isCopied ? "Copied!" : "Copy to clipboard"}
                          </MenuItem>
                          <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                          <MenuItem
                            onClick={handleSaveToWorkspace}
                            disabled={!workspaceRoot || isSavingToWorkspace}
                          >
                            Save to workspace
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                    {planDetailsExpanded ? (
                      <div className="mt-4 overflow-hidden rounded-none bg-transparent">
                        <div className="pb-4 pt-3.5">
                          <ChatMarkdown
                            text={displayedPlanMarkdown ?? ""}
                            cwd={markdownCwd}
                            isStreaming={false}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenFilePath={onOpenFilePath}
                            enableLocalFileLinks={enableLocalFileLinks}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {todoPlan ? (
                  <div className="border-t border-border/50 pt-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                          Todos
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="group inline-flex items-center gap-1.5 rounded-sm text-sm font-medium tracking-tight text-foreground"
                            onClick={() => setTodoDetailsExpanded((value) => !value)}
                            aria-expanded={todoDetailsExpanded}
                            aria-label={
                              todoDetailsExpanded ? "Collapse todo details" : "Expand todo details"
                            }
                          >
                            {todoDetailsExpanded ? (
                              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                            ) : (
                              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
                            )}
                            <span>Checklist</span>
                          </button>
                        </div>
                      </div>
                      {planProgress ? (
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {hasActionableTodo ? (
                            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/8 px-2.5 py-1 text-[11px] font-medium text-blue-300">
                              <Spinner className="size-3.5" />
                              <span className="tabular-nums">
                                {formatPlanProgressValue(
                                  planProgress.currentIndex ?? 1,
                                  progressDigits,
                                )}
                                /{formatPlanProgressValue(planProgress.total, progressDigits)}
                              </span>
                            </div>
                          ) : (
                            <p className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground">
                              {planProgress.completed}/{planProgress.total} done
                            </p>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {todoDetailsExpanded && planProgress ? (
                      <div className="mt-4 p-0">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                          <div
                            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(96,165,250,0.95),rgba(59,130,246,0.58))] transition-[width] duration-300 ease-out"
                            style={{ width: `${completedPercent}%` }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {todoDetailsExpanded && displaySteps.length > 0 ? (
                      <div className="mt-4 space-y-2.5">
                        {(() => {
                          const stepOccurrenceByText = new Map<string, number>();
                          return displaySteps.map((step) => {
                            const seenCount = stepOccurrenceByText.get(step.step) ?? 0;
                            stepOccurrenceByText.set(step.step, seenCount + 1);
                            const stepKey =
                              seenCount === 0 ? step.step : `${step.step}:${seenCount}`;
                            return (
                              <div
                                key={stepKey}
                                className="flex items-start gap-3 px-0 py-2.5 transition-colors duration-200"
                              >
                                <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                                <div className="min-w-0 flex-1">
                                  <p
                                    className={cn(
                                      "text-[13px] leading-snug",
                                      step.status === "completed"
                                        ? "text-muted-foreground line-through decoration-muted-foreground"
                                        : step.status === "inProgress"
                                          ? "text-foreground"
                                          : "text-muted-foreground",
                                    )}
                                  >
                                    {step.step}
                                  </p>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
});

export type { PlanSummaryPanelProps };
