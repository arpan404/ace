import { type ReactNode, useEffect, useReducer } from "react";
import { type ProviderKind } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  DiffIcon,
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
import { APP_PANEL_CLASS_NAME } from "~/lib/appChrome";
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
    <section className="border-t border-border/38 px-4 py-4 first:border-t-0 sm:px-5">
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

interface PlanSummaryPanelUiState {
  readonly summaryDetailsExpanded: boolean;
  readonly planDetailsExpanded: boolean;
  readonly todoDetailsExpanded: boolean;
  readonly isSavingToWorkspace: boolean;
  readonly summaryRequestStartedAt: string | null;
}

type PlanSummaryPanelUiAction =
  | { readonly type: "toggle-summary-details" }
  | { readonly type: "toggle-plan-details" }
  | { readonly type: "toggle-todo-details" }
  | { readonly type: "set-saving-to-workspace"; readonly isSavingToWorkspace: boolean }
  | { readonly type: "set-summary-request-started-at"; readonly startedAt: string | null };

const INITIAL_PLAN_SUMMARY_PANEL_UI_STATE: PlanSummaryPanelUiState = {
  summaryDetailsExpanded: true,
  planDetailsExpanded: true,
  todoDetailsExpanded: true,
  isSavingToWorkspace: false,
  summaryRequestStartedAt: null,
};

function planSummaryPanelUiStateReducer(
  state: PlanSummaryPanelUiState,
  action: PlanSummaryPanelUiAction,
): PlanSummaryPanelUiState {
  switch (action.type) {
    case "toggle-summary-details":
      return { ...state, summaryDetailsExpanded: !state.summaryDetailsExpanded };
    case "toggle-plan-details":
      return { ...state, planDetailsExpanded: !state.planDetailsExpanded };
    case "toggle-todo-details":
      return { ...state, todoDetailsExpanded: !state.todoDetailsExpanded };
    case "set-saving-to-workspace":
      return state.isSavingToWorkspace === action.isSavingToWorkspace
        ? state
        : { ...state, isSavingToWorkspace: action.isSavingToWorkspace };
    case "set-summary-request-started-at":
      return state.summaryRequestStartedAt === action.startedAt
        ? state
        : { ...state, summaryRequestStartedAt: action.startedAt };
  }
}

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

function SummaryWorkingIndicator() {
  return (
    <span
      aria-hidden="true"
      className="working-activity-indicator text-[13px]"
      data-working-activity-indicator="true"
    >
      <span className="working-activity-indicator-dot" />
      <span className="working-activity-indicator-dot" />
      <span className="working-activity-indicator-dot" />
    </span>
  );
}

function SummaryGenerationNotice({ hasExistingSummary }: { hasExistingSummary: boolean }) {
  return (
    <output
      className="inline-flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <SummaryWorkingIndicator />
      <span>{hasExistingSummary ? "Updating summary" : "Generating summary"}</span>
    </output>
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
    <div className="space-y-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <SummaryPanelSectionLabel>Diff summary</SummaryPanelSectionLabel>
          <p className="text-sm font-semibold text-foreground">Working tree changes</p>
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

function PlanSummaryTextSection({
  generatedWorkspaceSummary,
  workspaceDiffSummary,
  actions,
  isRegeneratingSummary,
  summaryDetailsExpanded,
  markdownCwd,
  onOpenBrowserUrl,
  onOpenFilePath,
  enableLocalFileLinks,
  onToggleSummaryDetails,
}: {
  readonly generatedWorkspaceSummary: GeneratedWorkspaceSummary;
  readonly workspaceDiffSummary: WorkspaceDiffSummary | null;
  readonly actions: ReactNode;
  readonly isRegeneratingSummary: boolean;
  readonly summaryDetailsExpanded: boolean;
  readonly markdownCwd: string | undefined;
  readonly onOpenBrowserUrl: ((url: string) => void) | null;
  readonly onOpenFilePath: ((path: string) => void) | null;
  readonly enableLocalFileLinks: boolean;
  readonly onToggleSummaryDetails: () => void;
}) {
  return (
    <SummaryPanelSection>
      <div className="space-y-4">
        {workspaceDiffSummary ? (
          <DiffSummaryOverview workspaceDiffSummary={workspaceDiffSummary} actions={actions} />
        ) : null}
        <div>
          <div className="flex items-start justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              className={cn(PLAN_SUMMARY_DISCLOSURE_BUTTON_CLASS_NAME, "gap-2")}
              onClick={onToggleSummaryDetails}
              aria-expanded={summaryDetailsExpanded}
              aria-label={
                summaryDetailsExpanded ? "Collapse summary details" : "Expand summary details"
              }
            >
              {summaryDetailsExpanded ? (
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground/85" />
              )}
              <SummaryPanelSectionLabel>Summary</SummaryPanelSectionLabel>
            </Button>
            {!workspaceDiffSummary ? actions : null}
          </div>
          {isRegeneratingSummary ? (
            <div className="mt-3">
              <SummaryGenerationNotice hasExistingSummary={true} />
            </div>
          ) : null}
          {summaryDetailsExpanded ? (
            <div className="mt-3.5">
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
    </SummaryPanelSection>
  );
}

function DiffOnlySummarySection({
  workspaceDiffSummary,
  actions,
  isRegeneratingSummary,
}: {
  readonly workspaceDiffSummary: WorkspaceDiffSummary;
  readonly actions: ReactNode;
  readonly isRegeneratingSummary: boolean;
}) {
  return (
    <SummaryPanelSection>
      <div className="space-y-4">
        <DiffSummaryOverview workspaceDiffSummary={workspaceDiffSummary} actions={actions} />
        {isRegeneratingSummary ? <SummaryGenerationNotice hasExistingSummary={false} /> : null}
      </div>
    </SummaryPanelSection>
  );
}

function EmptyChangesSection() {
  return (
    <SummaryPanelSection>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <SummaryPanelSectionLabel>Changes</SummaryPanelSectionLabel>
          <p className="text-sm font-semibold text-foreground">No changes</p>
          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            There are no uncommitted code changes.
          </p>
        </div>
      </div>
    </SummaryPanelSection>
  );
}

function PlanMarkdownSection({
  planTitle,
  displayedPlanMarkdown,
  markdownCwd,
  onOpenBrowserUrl,
  onOpenFilePath,
  enableLocalFileLinks,
  planDetailsExpanded,
  isCopied,
  isSavingToWorkspace,
  workspaceRoot,
  onTogglePlanDetails,
  onCopyPlan,
  onDownload,
  onSaveToWorkspace,
}: {
  readonly planTitle: string | null;
  readonly displayedPlanMarkdown: string | null;
  readonly markdownCwd: string | undefined;
  readonly onOpenBrowserUrl: ((url: string) => void) | null;
  readonly onOpenFilePath: ((path: string) => void) | null;
  readonly enableLocalFileLinks: boolean;
  readonly planDetailsExpanded: boolean;
  readonly isCopied: boolean;
  readonly isSavingToWorkspace: boolean;
  readonly workspaceRoot: string | undefined;
  readonly onTogglePlanDetails: () => void;
  readonly onCopyPlan: () => void;
  readonly onDownload: () => void;
  readonly onSaveToWorkspace: () => void;
}) {
  return (
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
              onClick={onTogglePlanDetails}
              aria-expanded={planDetailsExpanded}
              aria-label={planDetailsExpanded ? "Collapse plan details" : "Expand plan details"}
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
            <MenuItem onClick={onCopyPlan}>{isCopied ? "Copied!" : "Copy to clipboard"}</MenuItem>
            <MenuItem onClick={onDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={onSaveToWorkspace} disabled={!workspaceRoot || isSavingToWorkspace}>
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
  );
}

function TodoChecklistSection({
  displaySteps,
  planProgress,
  completedPercent,
  todoDetailsExpanded,
  onToggleTodoDetails,
}: {
  readonly displaySteps: ActivePlanState["steps"];
  readonly planProgress: ReturnType<typeof summarizeActivePlan>;
  readonly completedPercent: number;
  readonly todoDetailsExpanded: boolean;
  readonly onToggleTodoDetails: () => void;
}) {
  return (
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
              onClick={onToggleTodoDetails}
              aria-expanded={todoDetailsExpanded}
              aria-label={todoDetailsExpanded ? "Collapse todo details" : "Expand todo details"}
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
              const stepKey = seenCount === 0 ? step.step : `${step.step}:${seenCount}`;
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
  );
}

export function PlanSummaryPanel({
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
  const [uiState, dispatchUiState] = useReducer(
    planSummaryPanelUiStateReducer,
    INITIAL_PLAN_SUMMARY_PANEL_UI_STATE,
  );
  const {
    isSavingToWorkspace,
    planDetailsExpanded,
    summaryDetailsExpanded,
    summaryRequestStartedAt,
    todoDetailsExpanded,
  } = uiState;
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const effectivePlan = activePlan;
  const effectiveProposedPlan = activeProposedPlan;
  const effectiveGeneratedWorkspaceSummary = generatedWorkspaceSummary;
  const effectiveWorkspaceDiffSummary = workspaceDiffSummary;
  const effectivePlanMarkdown = effectiveProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = effectivePlanMarkdown
    ? stripDisplayedPlanMarkdown(effectivePlanMarkdown)
    : null;
  const planTitle = effectivePlanMarkdown ? proposedPlanTitle(effectivePlanMarkdown) : null;
  const planProgress = summarizeActivePlan(effectivePlan);
  const displaySteps = getDisplaySteps(effectivePlan?.steps ?? []);
  const completedPercent = planProgress
    ? Math.round((planProgress.completed / Math.max(planProgress.total, 1)) * 100)
    : 0;
  const generatedWorkspaceSummaryCreatedAt = effectiveGeneratedWorkspaceSummary?.createdAt ?? null;
  const isRegeneratingSummary =
    summaryRequestStartedAt !== null &&
    !summaryGeneratedAfterRequest(generatedWorkspaceSummaryCreatedAt, summaryRequestStartedAt);

  useEffect(() => {
    if (summaryRequestStartedAt === null) {
      return;
    }
    const timeout = window.setTimeout(() => {
      dispatchUiState({ type: "set-summary-request-started-at", startedAt: null });
    }, 90_000);
    return () => window.clearTimeout(timeout);
  }, [summaryRequestStartedAt]);

  const handleCopyPlan = () => {
    if (!effectivePlanMarkdown) return;
    copyToClipboard(effectivePlanMarkdown);
  };

  const handleDownload = () => {
    if (!effectivePlanMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(effectivePlanMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(effectivePlanMarkdown));
  };

  const handleSaveToWorkspace = () => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !effectivePlanMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(effectivePlanMarkdown);
    dispatchUiState({ type: "set-saving-to-workspace", isSavingToWorkspace: true });
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
        () => dispatchUiState({ type: "set-saving-to-workspace", isSavingToWorkspace: false }),
        () => dispatchUiState({ type: "set-saving-to-workspace", isSavingToWorkspace: false }),
      );
  };

  const handleRegenerateSummary = () => {
    if (!onRegenerateSummary || isRegeneratingSummary) {
      return;
    }

    const requestStartedAt = new Date().toISOString();
    dispatchUiState({ type: "set-summary-request-started-at", startedAt: requestStartedAt });
    void Promise.resolve(onRegenerateSummary()).catch((error: unknown) => {
      dispatchUiState({ type: "set-summary-request-started-at", startedAt: null });
      toastManager.add({
        type: "error",
        title: "Could not regenerate summary",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

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
            variant="ghost"
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
          <SparklesIcon className="size-3" />
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
                variant="ghost"
                onClick={onOpenDiffPanel}
                aria-label="Open review"
              />
            }
          >
            <DiffIcon className="size-3.5" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipPopup side="top">Open review</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  ) : null;
  const handleToggleSummaryDetails = () => {
    dispatchUiState({ type: "toggle-summary-details" });
  };
  const handleTogglePlanDetails = () => {
    dispatchUiState({ type: "toggle-plan-details" });
  };
  const handleToggleTodoDetails = () => {
    dispatchUiState({ type: "toggle-todo-details" });
  };

  return (
    <div className={cn("flex min-h-0 flex-1 overflow-hidden", APP_PANEL_CLASS_NAME)}>
      <section className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <ScrollArea className="min-h-0 flex-1" data-plan-summary-scroll-container="true">
          <div className="flex min-h-full flex-col">
            {!hasAnyContent ? null : (
              <>
                {effectiveGeneratedWorkspaceSummary ? (
                  <PlanSummaryTextSection
                    generatedWorkspaceSummary={effectiveGeneratedWorkspaceSummary}
                    workspaceDiffSummary={effectiveWorkspaceDiffSummary}
                    actions={diffSummaryActions}
                    isRegeneratingSummary={isRegeneratingSummary}
                    summaryDetailsExpanded={summaryDetailsExpanded}
                    markdownCwd={markdownCwd}
                    onOpenBrowserUrl={onOpenBrowserUrl}
                    onOpenFilePath={onOpenFilePath}
                    enableLocalFileLinks={enableLocalFileLinks}
                    onToggleSummaryDetails={handleToggleSummaryDetails}
                  />
                ) : null}

                {effectiveWorkspaceDiffSummary && !effectiveGeneratedWorkspaceSummary ? (
                  <DiffOnlySummarySection
                    workspaceDiffSummary={effectiveWorkspaceDiffSummary}
                    actions={diffSummaryActions}
                    isRegeneratingSummary={isRegeneratingSummary}
                  />
                ) : null}

                {!effectiveGeneratedWorkspaceSummary && !effectiveWorkspaceDiffSummary ? (
                  <EmptyChangesSection />
                ) : null}

                {effectivePlanMarkdown ? (
                  <PlanMarkdownSection
                    planTitle={planTitle}
                    displayedPlanMarkdown={displayedPlanMarkdown}
                    markdownCwd={markdownCwd}
                    onOpenBrowserUrl={onOpenBrowserUrl}
                    onOpenFilePath={onOpenFilePath}
                    enableLocalFileLinks={enableLocalFileLinks}
                    planDetailsExpanded={planDetailsExpanded}
                    isCopied={isCopied}
                    isSavingToWorkspace={isSavingToWorkspace}
                    workspaceRoot={workspaceRoot}
                    onTogglePlanDetails={handleTogglePlanDetails}
                    onCopyPlan={handleCopyPlan}
                    onDownload={handleDownload}
                    onSaveToWorkspace={handleSaveToWorkspace}
                  />
                ) : null}

                {todoPlan ? (
                  <TodoChecklistSection
                    displaySteps={displaySteps}
                    planProgress={planProgress}
                    completedPercent={completedPercent}
                    todoDetailsExpanded={todoDetailsExpanded}
                    onToggleTodoDetails={handleToggleTodoDetails}
                  />
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </section>
    </div>
  );
}

export type { PlanSummaryPanelProps };
