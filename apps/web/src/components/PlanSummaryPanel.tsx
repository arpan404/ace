import { memo, useCallback, useMemo, useState } from "react";
import { type ProviderKind } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
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
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

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

export const PlanSummaryPanel = memo(function PlanSummaryPanel({
  activePlan,
  activeProposedPlan,
  generatedWorkspaceSummary,
  activeProvider = null,
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
  const isCopilotSummary = activeProvider === "githubCopilot";
  const todoMeta = useMemo(() => {
    if (!effectivePlan) {
      return null;
    }
    if (isCopilotSummary) {
      return effectivePlan.source === "plan-update"
        ? {
            badge: "Live",
            label: "Live todo state",
            detail: "Execution checklist mirrored from Copilot's session state.",
          }
        : {
            badge: "Derived",
            label: "Execution checklist",
            detail:
              "Inferred from current task activity because no native todo update is available.",
          };
    }
    return effectivePlan.source === "plan-update"
      ? {
          badge: "Plan",
          label: "Current plan",
          detail: null,
        }
      : {
          badge: "Derived",
          label: "Current plan",
          detail: "Derived from task activity.",
        };
  }, [effectivePlan, isCopilotSummary]);
  const planMeta = useMemo(() => {
    if (!effectivePlanMarkdown) {
      return null;
    }
    return isCopilotSummary
      ? {
          badge: "plan.md",
          label: "Plan document",
          detail: "Native Copilot plan file prepared for review.",
        }
      : {
          badge: "Draft",
          label: planTitle ?? "Full plan",
          detail: null,
        };
  }, [effectivePlanMarkdown, isCopilotSummary, planTitle]);

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

    setIsRegeneratingSummary(true);
    void Promise.resolve(onRegenerateSummary())
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not regenerate summary",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .finally(() => {
        setIsRegeneratingSummary(false);
      });
  }, [isRegeneratingSummary, onRegenerateSummary]);

  const hasTodoSection = Boolean(effectivePlan && effectivePlan.steps.length > 0);
  const todoPlan = hasTodoSection ? effectivePlan : null;
  const hasAnyContent = Boolean(
    generatedWorkspaceSummary || workspaceDiffSummary || effectivePlanMarkdown || hasTodoSection,
  );
  const regenerateSummaryLabel = generatedWorkspaceSummary
    ? "Regenerate summary"
    : "Generate summary";
  const regenerateSummaryButton = onRegenerateSummary ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleRegenerateSummary}
      disabled={isRegeneratingSummary}
      aria-busy={isRegeneratingSummary}
    >
      {isRegeneratingSummary ? <LoaderIcon className="mr-1 size-3.5 animate-spin" /> : null}
      {regenerateSummaryLabel}
    </Button>
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
                  <div>
                    <div className="min-w-0 space-y-3">
                      {workspaceDiffSummary ? (
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <Badge
                                variant="secondary"
                                className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                              >
                                {formatDiffCount(workspaceDiffSummary.fileCount)} files
                              </Badge>
                              <p className="text-sm font-medium tracking-tight text-foreground">
                                Diff summary
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {regenerateSummaryButton}
                              {onOpenDiffPanel ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={onOpenDiffPanel}
                                >
                                  Open review
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                            <span className="mr-2">Current diff:</span>
                            <span className="font-medium text-foreground">
                              <DiffStatLabel
                                additions={workspaceDiffSummary.additions}
                                deletions={workspaceDiffSummary.deletions}
                              />
                            </span>
                          </p>
                        </div>
                      ) : null}
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          className="group inline-flex items-center gap-2 rounded-sm"
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
                          <Badge
                            variant="secondary"
                            className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                          >
                            AI
                          </Badge>
                        </button>
                        {!workspaceDiffSummary ? regenerateSummaryButton : null}
                      </div>
                    </div>
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
                ) : null}

                {workspaceDiffSummary && !generatedWorkspaceSummary ? (
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                          Changes
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                          >
                            {formatDiffCount(workspaceDiffSummary.fileCount)} files
                          </Badge>
                          <p className="text-sm font-medium tracking-tight text-foreground">
                            Diff summary
                          </p>
                        </div>
                        <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                          <span className="mr-2">Current diff:</span>
                          <span className="font-medium text-foreground">
                            <DiffStatLabel
                              additions={workspaceDiffSummary.additions}
                              deletions={workspaceDiffSummary.deletions}
                            />
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {regenerateSummaryButton}
                        {onOpenDiffPanel ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={onOpenDiffPanel}
                          >
                            Open review
                          </Button>
                        ) : null}
                      </div>
                    </div>
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
                          {planMeta ? (
                            <Badge
                              variant="secondary"
                              className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                            >
                              {planMeta.badge}
                            </Badge>
                          ) : null}
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
                        {planMeta?.detail ? (
                          <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                            {planMeta.detail}
                          </p>
                        ) : null}
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
                          {todoMeta ? (
                            <Badge
                              variant="secondary"
                              className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                            >
                              {todoMeta.badge}
                            </Badge>
                          ) : null}
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
                            <span>{todoMeta?.label ?? "Current plan"}</span>
                          </button>
                        </div>
                        {todoDetailsExpanded && todoMeta?.detail ? (
                          <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                            {todoMeta.detail}
                          </p>
                        ) : null}
                        {todoDetailsExpanded && todoPlan.explanation ? (
                          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                            {todoPlan.explanation}
                          </p>
                        ) : null}
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
                        <div className="flex items-center justify-between gap-3">
                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                              Execution
                            </p>
                            <p className="text-sm font-medium tracking-tight text-foreground">
                              {hasActionableTodo && planProgress.currentStep
                                ? planProgress.currentStep
                                : "Waiting for the next actionable todo"}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-[11px] font-medium tabular-nums text-muted-foreground">
                              {completedPercent}% complete
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted/60">
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
                          return displaySteps.map((step, index) => {
                            const seenCount = stepOccurrenceByText.get(step.step) ?? 0;
                            stepOccurrenceByText.set(step.step, seenCount + 1);
                            const stepKey =
                              seenCount === 0 ? step.step : `${step.step}:${seenCount}`;
                            const isCurrentActionableStep =
                              planProgress?.currentIndex != null &&
                              index + 1 === planProgress.currentIndex;
                            return (
                              <div
                                key={stepKey}
                                className={cn(
                                  "flex items-start gap-3 px-0 py-2.5 transition-colors duration-200",
                                  step.status === "inProgress" && "bg-transparent",
                                  step.status === "completed" && "bg-transparent",
                                  isCurrentActionableStep &&
                                    step.status === "pending" &&
                                    "bg-transparent",
                                )}
                              >
                                <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                                      {formatPlanProgressValue(index + 1, progressDigits)}
                                    </span>
                                    {isCurrentActionableStep ? (
                                      <Badge
                                        variant="secondary"
                                        className="rounded-md border border-blue-500/25 bg-blue-500/8 px-1.5 py-0 text-[10px] font-medium text-blue-300"
                                      >
                                        {step.status === "inProgress" ? "In progress" : "Ready"}
                                      </Badge>
                                    ) : null}
                                    {step.status === "completed" ? (
                                      <span className="text-[10px] font-medium tracking-wide text-emerald-400/90 uppercase">
                                        Done
                                      </span>
                                    ) : null}
                                  </div>
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
