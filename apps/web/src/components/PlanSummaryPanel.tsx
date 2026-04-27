import { memo, useCallback, useMemo, useState } from "react";
import { type ProviderKind } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
} from "lucide-react";

import type { ActivePlanState, LatestProposedPlanState } from "../session-logic";
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
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

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
  activeProvider?: ProviderKind | null;
  markdownCwd: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  workspaceRoot: string | undefined;
}

const SECTION_CLASS_NAME =
  "rounded-2xl border border-border/70 bg-linear-to-br from-card via-card/95 to-card/80 p-4 shadow-[0_18px_42px_-30px_rgba(0,0,0,0.6)]";
const SECTION_LABEL_CLASS_NAME =
  "text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase";

export const PlanSummaryPanel = memo(function PlanSummaryPanel({
  activePlan,
  activeProposedPlan,
  activeProvider = null,
  markdownCwd,
  onOpenBrowserUrl = null,
  workspaceRoot,
}: PlanSummaryPanelProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const canCollapsePlan = useMemo(() => {
    if (!displayedPlanMarkdown) {
      return false;
    }
    return displayedPlanMarkdown.length > 900 || displayedPlanMarkdown.split("\n").length > 20;
  }, [displayedPlanMarkdown]);
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
  const isCopilotSummary = activeProvider === "githubCopilot";
  const todoMeta = useMemo(() => {
    if (!activePlan) {
      return null;
    }
    if (isCopilotSummary) {
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
  }, [activePlan, isCopilotSummary]);
  const planMeta = useMemo(() => {
    if (!planMarkdown) {
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
  }, [isCopilotSummary, planMarkdown, planTitle]);

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [copyToClipboard, planMarkdown]);

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
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <section className={SECTION_CLASS_NAME}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <p className={SECTION_LABEL_CLASS_NAME}>Plan</p>
            {planMarkdown ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {planMeta ? (
                    <Badge
                      variant="secondary"
                      className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                    >
                      {planMeta.badge}
                    </Badge>
                  ) : null}
                  <p className="text-sm font-medium tracking-tight text-foreground">
                    {planTitle ?? "Proposed plan"}
                  </p>
                </div>
                {planMeta?.detail ? (
                  <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                    {planMeta.detail}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                Proposed plans will appear here when the thread has a draft ready for review.
              </p>
            )}
          </div>
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
        </div>

        {planMarkdown ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-background/80">
            {canCollapsePlan ? (
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 px-3 py-2.5 text-left"
                onClick={() => setProposedPlanExpanded((value) => !value)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase group-hover:text-foreground/80">
                  {proposedPlanExpanded ? "Hide plan preview" : "Open plan preview"}
                </span>
              </button>
            ) : null}
            {!canCollapsePlan || proposedPlanExpanded ? (
              <div className={cn("p-3", canCollapsePlan && "border-t border-border/60")}>
                <ChatMarkdown
                  text={displayedPlanMarkdown ?? ""}
                  cwd={markdownCwd}
                  isStreaming={false}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </div>
            ) : (
              <div className="border-t border-border/60 px-3 py-2.5">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Keep the summary focused while the full plan stays one click away.
                </p>
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section className={SECTION_CLASS_NAME}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <p className={SECTION_LABEL_CLASS_NAME}>Todos</p>
            {activePlan && activePlan.steps.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {todoMeta ? (
                    <Badge
                      variant="secondary"
                      className="rounded-md border border-border/50 bg-background/70 px-1.5 py-0 text-[10px] font-medium text-foreground/80"
                    >
                      {todoMeta.badge}
                    </Badge>
                  ) : null}
                  <p className="text-sm font-medium tracking-tight text-foreground">
                    {todoMeta?.label ?? "Current plan"}
                  </p>
                </div>
                {todoMeta?.detail ? (
                  <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                    {todoMeta.detail}
                  </p>
                ) : null}
                {activePlan.explanation ? (
                  <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                    {activePlan.explanation}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                Todo summary will appear here when the thread has actionable tasks.
              </p>
            )}
          </div>
          {planStepSummary ? (
            <p className="shrink-0 rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground">
              {planStepSummary.completed}/{planStepSummary.total} done
            </p>
          ) : null}
        </div>

        {activePlan && activePlan.steps.length > 0 ? (
          <div className="mt-4 space-y-2">
            {(() => {
              const stepOccurrenceByText = new Map<string, number>();
              return activePlan.steps.map((step) => {
                const seenCount = stepOccurrenceByText.get(step.step) ?? 0;
                stepOccurrenceByText.set(step.step, seenCount + 1);
                const stepKey = seenCount === 0 ? step.step : `${step.step}:${seenCount}`;
                return (
                  <div
                    key={stepKey}
                    className={cn(
                      "flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/75 px-3 py-2.5 transition-colors duration-200",
                      step.status === "inProgress" && "border-blue-500/20 bg-blue-500/5",
                      step.status === "completed" && "border-emerald-500/20 bg-emerald-500/5",
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
              });
            })()}
          </div>
        ) : null}
      </section>
    </div>
  );
});

export type { PlanSummaryPanelProps };
