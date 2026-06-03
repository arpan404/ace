import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type ProviderKind } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DiffIcon,
  EllipsisIcon,
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
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const diffCountFormatter = new Intl.NumberFormat();
const PLAN_SUMMARY_DISCLOSURE_BUTTON_CLASS_NAME =
  "group inline-flex h-auto min-w-0 items-center gap-1.5 rounded-none bg-transparent p-0 text-left shadow-none hover:!bg-transparent active:!translate-y-0 active:!bg-transparent aria-expanded:!bg-transparent dark:hover:!bg-transparent dark:active:!bg-transparent focus-visible:border-transparent focus-visible:ring-0";

function SummaryPanelSection({ children }: { children: ReactNode }) {
  return (
    <section className="border-t border-border/55 px-4 py-4 first:border-t-0 sm:px-5">
      {children}
    </section>
  );
}

function SummaryPanelSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </p>
  );
}

function stepStatusIcon(status: string) {
  if (status === "completed") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/45 text-muted-foreground/70">
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Spinner className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/45 bg-transparent" />
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
    <output className="flex items-center gap-2 text-xs text-blue-300">
      <Spinner aria-hidden="true" className="size-3.5 text-blue-300" role="presentation" />
      <span>{hasExistingSummary ? "Updating summary..." : "Generating summary..."}</span>
    </output>
  );
}

const DEMO_ACTIVE_PLAN: ActivePlanState = {
  createdAt: "2026-06-03T00:00:00.000Z",
  source: "plan-update",
  turnId: null,
  explanation: "Tighten the side panel into a calmer review cockpit.",
  steps: [
    { step: "Map current panel routes and tab affordances", status: "completed" },
    { step: "Restyle summary tabs for dense review work", status: "completed" },
    { step: "Wire demo data across summary, plan, todos, and diff", status: "inProgress" },
    { step: "Verify responsive scroll and action states", status: "pending" },
    { step: "Run format, lint, typecheck, and focused tests", status: "pending" },
  ],
};

const DEMO_PROPOSED_PLAN: LatestProposedPlanState = {
  id: "summary-panel-demo-plan",
  turnId: null,
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
  implementedAt: null,
  implementationThreadId: null,
  planMarkdown: [
    "# Summary side panel redesign",
    "",
    "1. Preserve existing tab routing, reorder, overflow, and close behavior.",
    "2. Replace the pill-heavy tab chrome with a quieter segmented surface.",
    "3. Keep summary, plan, todo, and diff states visible in dev demo mode.",
    "4. Validate that long content still scrolls inside the panel body.",
  ].join("\n"),
};

const DEMO_WORKSPACE_SUMMARY: GeneratedWorkspaceSummary = {
  createdAt: "2026-06-03T00:00:00.000Z",
  turnId: null,
  headline: "Summary panel demo",
  summary: "Redesigned the side panel tabs and added seeded summary-panel demo content.",
  keyChanges: [
    "Made the tab strip feel more like a compact work surface.",
    "Added demo data for summary, plan, todos, and diff metadata.",
  ],
  risks: ["Confirm the tab strip still reads well with many open editor and browser tabs."],
  markdown: [
    "### Summary panel demo",
    "",
    "The summary side panel now has a calmer tab treatment and seeded demo content for review.",
    "",
    "- Summary markdown renders with local link handling intact.",
    "- Plan content includes action menu coverage.",
    "- Todos show completed, running, and pending states.",
    "- Diff metadata is populated without requiring real workspace changes.",
  ].join("\n"),
};

const DEMO_WORKSPACE_DIFF_SUMMARY: WorkspaceDiffSummary = {
  additions: 1284,
  deletions: 326,
  fileCount: 7,
};

function isSummaryPanelDemoEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const searchParams = new URLSearchParams(window.location.search);
  return (
    searchParams.get("summaryDemo") === "full" || searchParams.get("environmentDemo") === "full"
  );
}

function DiffSummaryOverview({
  workspaceDiffSummary,
  actions,
}: {
  workspaceDiffSummary: WorkspaceDiffSummary;
  actions: ReactNode;
}) {
  const changedFilesLabel =
    workspaceDiffSummary.fileCount === 1
      ? "1 file changed"
      : `${formatDiffCount(workspaceDiffSummary.fileCount)} files changed`;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SummaryPanelSectionLabel>Diff summary</SummaryPanelSectionLabel>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-sm font-medium text-foreground">Working tree</p>
            <p className="text-xs text-muted-foreground">{changedFilesLabel}</p>
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <dl className="grid max-w-[18rem] grid-cols-[auto_auto] gap-x-6 gap-y-1 text-xs leading-5">
        <div className="contents">
          <dt className="text-muted-foreground">Added</dt>
          <dd className="text-right font-medium tabular-nums text-foreground/85">
            +{formatDiffCount(workspaceDiffSummary.additions)}
          </dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">Removed</dt>
          <dd className="text-right font-medium tabular-nums text-foreground/85">
            -{formatDiffCount(workspaceDiffSummary.deletions)}
          </dd>
        </div>
      </dl>
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

  const demoEnabled = isSummaryPanelDemoEnabled();
  const effectivePlan = demoEnabled ? DEMO_ACTIVE_PLAN : activePlan;
  const effectiveProposedPlan = demoEnabled ? DEMO_PROPOSED_PLAN : activeProposedPlan;
  const effectiveGeneratedWorkspaceSummary = demoEnabled
    ? DEMO_WORKSPACE_SUMMARY
    : generatedWorkspaceSummary;
  const effectiveWorkspaceDiffSummary = demoEnabled
    ? DEMO_WORKSPACE_DIFF_SUMMARY
    : workspaceDiffSummary;
  const effectivePlanMarkdown = effectiveProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = effectivePlanMarkdown
    ? stripDisplayedPlanMarkdown(effectivePlanMarkdown)
    : null;
  const planTitle = effectivePlanMarkdown ? proposedPlanTitle(effectivePlanMarkdown) : null;
  const planProgress = useMemo(() => summarizeActivePlan(effectivePlan), [effectivePlan]);
  const displaySteps = useMemo(
    () => getDisplaySteps(effectivePlan?.steps ?? []),
    [effectivePlan?.steps],
  );
  const completedPercent = planProgress
    ? Math.round((planProgress.completed / Math.max(planProgress.total, 1)) * 100)
    : 0;
  const generatedWorkspaceSummaryCreatedAt = effectiveGeneratedWorkspaceSummary?.createdAt ?? null;

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
    effectiveGeneratedWorkspaceSummary ||
    effectiveWorkspaceDiffSummary ||
    effectivePlanMarkdown ||
    hasTodoSection ||
    onRegenerateSummary,
  );
  const regenerateSummaryLabel = effectiveGeneratedWorkspaceSummary
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
            {effectiveGeneratedWorkspaceSummary ? (
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
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <section className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <ScrollArea className="min-h-0 flex-1" data-plan-summary-scroll-container="true">
          <div className="flex min-h-full flex-col">
            {!hasAnyContent ? null : (
              <>
                {effectiveGeneratedWorkspaceSummary ? (
                  <SummaryPanelSection>
                    <div className="space-y-4">
                      {effectiveWorkspaceDiffSummary ? (
                        <DiffSummaryOverview
                          workspaceDiffSummary={effectiveWorkspaceDiffSummary}
                          actions={diffSummaryActions}
                        />
                      ) : null}
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <Button
                            type="button"
                            variant="ghost"
                            className={cn(PLAN_SUMMARY_DISCLOSURE_BUTTON_CLASS_NAME, "gap-2")}
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
                            <SummaryPanelSectionLabel>Summary</SummaryPanelSectionLabel>
                          </Button>
                          {!effectiveWorkspaceDiffSummary ? regenerateSummaryButton : null}
                        </div>
                        {isRegeneratingSummary ? (
                          <div className="mt-3">
                            <SummaryGenerationNotice hasExistingSummary={true} />
                          </div>
                        ) : null}
                        {summaryDetailsExpanded ? (
                          <div className="mt-3.5">
                            <ChatMarkdown
                              text={effectiveGeneratedWorkspaceSummary.markdown}
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
                  </SummaryPanelSection>
                ) : null}

                {effectiveWorkspaceDiffSummary && !effectiveGeneratedWorkspaceSummary ? (
                  <SummaryPanelSection>
                    <div className="space-y-4">
                      <DiffSummaryOverview
                        workspaceDiffSummary={effectiveWorkspaceDiffSummary}
                        actions={diffSummaryActions}
                      />
                      {isRegeneratingSummary ? (
                        <SummaryGenerationNotice hasExistingSummary={false} />
                      ) : null}
                    </div>
                  </SummaryPanelSection>
                ) : null}

                {!effectiveGeneratedWorkspaceSummary && !effectiveWorkspaceDiffSummary ? (
                  <SummaryPanelSection>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <SummaryPanelSectionLabel>Changes</SummaryPanelSectionLabel>
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
                  </SummaryPanelSection>
                ) : null}

                {effectivePlanMarkdown ? (
                  <SummaryPanelSection>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <SummaryPanelSectionLabel>Plan</SummaryPanelSectionLabel>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            className={cn(
                              PLAN_SUMMARY_DISCLOSURE_BUTTON_CLASS_NAME,
                              "text-sm font-medium tracking-tight text-foreground",
                            )}
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
                          </Button>
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
                      <div className="mt-3.5 overflow-hidden">
                        <div className="pb-1">
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
                  </SummaryPanelSection>
                ) : null}

                {todoPlan ? (
                  <SummaryPanelSection>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <SummaryPanelSectionLabel>Todos</SummaryPanelSectionLabel>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            className={cn(
                              PLAN_SUMMARY_DISCLOSURE_BUTTON_CLASS_NAME,
                              "text-sm font-medium tracking-tight text-foreground",
                            )}
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
                          </Button>
                        </div>
                      </div>
                    </div>

                    {todoDetailsExpanded && planProgress ? (
                      <div className="mt-4 p-0">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                          <div
                            className="h-full rounded-full bg-muted-foreground/55 transition-[width] duration-300 ease-out"
                            style={{ width: `${completedPercent}%` }}
                          />
                        </div>
                      </div>
                    ) : null}

                    {todoDetailsExpanded && displaySteps.length > 0 ? (
                      <div className="mt-3 space-y-1.5">
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
                                className="flex items-start gap-2.5 py-2 transition-colors duration-200"
                              >
                                <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                                <div className="min-w-0 flex-1">
                                  <p
                                    className={cn(
                                      "text-[13px] leading-snug",
                                      step.status === "completed"
                                        ? "text-muted-foreground"
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
                  </SummaryPanelSection>
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </section>
    </div>
  );
});

export type { PlanSummaryPanelProps };
