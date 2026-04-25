import { memo, useState, useCallback, useMemo } from "react";
import { type ProviderKind } from "@ace/contracts";
import { type TimestampFormat } from "@ace/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

function stepStatusIcon(status: string): React.ReactNode {
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

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  activeProvider?: ProviderKind | null;
  markdownCwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  activeProvider = null,
  markdownCwd,
  onOpenBrowserUrl = null,
  workspaceRoot,
  timestampFormat,
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const planStepSummary = useMemo(() => {
    if (!activePlan || activePlan.steps.length === 0) {
      return null;
    }
    const completed = activePlan.steps.filter((step) => step.status === "completed").length;
    return {
      completed,
      total: activePlan.steps.length,
    };
  }, [activePlan]);
  const isCopilotPlanSidebar = activeProvider === "githubCopilot";
  const activePlanSectionMeta = useMemo(() => {
    if (!activePlan) {
      return null;
    }
    if (isCopilotPlanSidebar) {
      return activePlan.source === "plan-update"
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
    return activePlan.source === "plan-update"
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
  }, [activePlan, isCopilotPlanSidebar]);
  const proposedPlanMeta = useMemo(() => {
    if (!planMarkdown) {
      return null;
    }
    return isCopilotPlanSidebar
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
  }, [isCopilotPlanSidebar, planMarkdown, planTitle]);

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
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
  }, [planMarkdown, workspaceRoot]);

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-border/40 bg-card">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            Plan
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {planMarkdown ? (
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
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close plan sidebar"
            className="text-muted-foreground hover:text-foreground"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <section className="space-y-2 rounded-xl border border-border/40 bg-background/70 p-3">
              {(() => {
                const stepOccurrenceByText = new Map<string, number>();
                return (
                  <>
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          {activePlanSectionMeta ? (
                            <Badge
                              variant="secondary"
                              className="rounded-md border border-border/40 bg-muted/30 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                            >
                              {activePlanSectionMeta.badge}
                            </Badge>
                          ) : null}
                          <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                            {activePlanSectionMeta?.label ?? "Current plan"}
                          </p>
                        </div>
                        {activePlanSectionMeta?.detail ? (
                          <p className="max-w-[28ch] text-[11px] leading-relaxed text-muted-foreground">
                            {activePlanSectionMeta.detail}
                          </p>
                        ) : null}
                        {activePlan?.explanation ? (
                          <p className="text-[12px] leading-relaxed text-muted-foreground">
                            {activePlan.explanation}
                          </p>
                        ) : null}
                      </div>
                      {planStepSummary ? (
                        <p className="shrink-0 text-[10px] text-muted-foreground">
                          {planStepSummary.completed}/{planStepSummary.total} done
                        </p>
                      ) : null}
                    </div>
                    {activePlan.steps.map((step) => {
                      const seenCount = stepOccurrenceByText.get(step.step) ?? 0;
                      stepOccurrenceByText.set(step.step, seenCount + 1);
                      const stepKey = seenCount === 0 ? step.step : `${step.step}:${seenCount}`;
                      return (
                        <div
                          key={stepKey}
                          className={cn(
                            "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                            step.status === "inProgress" && "bg-blue-500/5",
                            step.status === "completed" && "bg-emerald-500/5",
                          )}
                        >
                          <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
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
                      );
                    })}
                  </>
                );
              })()}
            </section>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <section className="space-y-2 rounded-xl border border-border/40 bg-background/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {proposedPlanMeta ? (
                      <Badge
                        variant="secondary"
                        className="rounded-md border border-border/40 bg-muted/30 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                      >
                        {proposedPlanMeta.badge}
                      </Badge>
                    ) : null}
                    <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                      {proposedPlanMeta?.label ?? planTitle ?? "Full plan"}
                    </p>
                  </div>
                  {proposedPlanMeta?.detail ? (
                    <p className="max-w-[28ch] text-[11px] leading-relaxed text-muted-foreground">
                      {proposedPlanMeta.detail}
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase group-hover:text-muted-foreground">
                  {isCopilotPlanSidebar ? "Open plan preview" : (planTitle ?? "Full Plan")}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/40 bg-background p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                    onOpenBrowserUrl={onOpenBrowserUrl}
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Empty state */}
          {!activePlan && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
