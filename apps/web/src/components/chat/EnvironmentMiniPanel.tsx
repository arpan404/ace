import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@ace/contracts";
import { type ComponentProps, forwardRef } from "react";
import { ClipboardListIcon, ListTodoIcon, SlidersHorizontalIcon } from "lucide-react";
import { m } from "motion/react";

import BranchToolbar from "../BranchToolbar";
import EnvironmentGitSection from "../EnvironmentGitSection";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { formatSubagentSubtitle, statusLabel, SubagentPersonaIcon } from "./SubagentThreadsPanel";
import type { SubagentThread } from "./subagentThreads";
import type { ActivePlanProgressState } from "../../session-logic";
import { cn } from "~/lib/utils";
import { PANEL_SPRING_TRANSITION } from "~/lib/panelMotion";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

function formatDiffCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export const EnvironmentMiniPanel = forwardRef<
  HTMLElement,
  {
    activeProjectScripts: ProjectScript[] | undefined;
    activePlanProgress: ActivePlanProgressState | null;
    activeSubagentThreadId: string | null;
    activeThreadId: ThreadId;
    branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
    gitCwd: string | null;
    isGitRepo: boolean;
    isAgentWorking: boolean;
    keybindings: ResolvedKeybindingsConfig;
    layoutMode: "inline" | "popover";
    onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
    onDeleteProjectScript: (scriptId: string) => Promise<void>;
    onOpenDiffPanel: () => void;
    onOpenSummaryPanel: () => void;
    onRunProjectScript: (script: ProjectScript) => void;
    onSelectSubagentThread: (threadId: string) => void;
    onSubagentPanelOpen: () => void;
    onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
    onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
    preferredScriptId: string | null;
    subagentThreads: ReadonlyArray<SubagentThread>;
    workspaceChangeStat: { additions: number; deletions: number } | null;
    workspaceMode: ThreadWorkspaceMode;
  }
>(function EnvironmentMiniPanel(props, ref) {
  const hasChanges =
    props.workspaceChangeStat !== null &&
    (props.workspaceChangeStat.additions > 0 || props.workspaceChangeStat.deletions > 0);
  const workspaceChangeStat = props.workspaceChangeStat;
  const activeSubagentThreads = props.subagentThreads.filter(
    (thread) => thread.status === "running",
  );
  const activeTodoProgress =
    props.isAgentWorking &&
    props.activePlanProgress &&
    props.activePlanProgress.currentIndex !== null
      ? {
          currentIndex: props.activePlanProgress.currentIndex,
          currentStep: props.activePlanProgress.currentStep,
          total: props.activePlanProgress.total,
        }
      : null;
  const todoProgressWidth = activeTodoProgress
    ? Math.max(2, String(activeTodoProgress.total).length)
    : 2;
  const planProgressWidth = props.activePlanProgress
    ? Math.max(2, String(props.activePlanProgress.total).length)
    : 2;

  return (
    <m.aside
      ref={ref}
      className={cn(
        "pointer-events-auto absolute top-3 right-3 z-30 max-h-[calc(100%-1.5rem)] w-72 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-2xl border border-border/70 bg-popover/90 p-3 text-popover-foreground shadow-2xl backdrop-blur-xl",
        props.layoutMode === "inline" ? "shadow-black/10" : "shadow-black/20",
      )}
      initial={{ opacity: 0, scale: 0.985, x: 22 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.985, x: 18 }}
      data-slot="environment-mini-panel"
      transition={PANEL_SPRING_TRANSITION}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium text-muted-foreground">Environment</h2>
      </div>

      <div className="space-y-1">
        <button
          type="button"
          className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent/60 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
          disabled={!props.isGitRepo}
          onClick={props.onOpenDiffPanel}
        >
          <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1">Changes</span>
          {hasChanges && workspaceChangeStat ? (
            <span className="inline-flex items-center gap-1 font-medium tabular-nums">
              {workspaceChangeStat.additions > 0 ? (
                <span className="text-success">
                  +{formatDiffCount(workspaceChangeStat.additions)}
                </span>
              ) : null}
              {workspaceChangeStat.deletions > 0 ? (
                <span className="text-destructive">
                  -{formatDiffCount(workspaceChangeStat.deletions)}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-[12px] text-muted-foreground">Clean</span>
          )}
        </button>
        {props.activePlanProgress ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent/60 hover:text-accent-foreground"
            onClick={props.onOpenSummaryPanel}
          >
            <ClipboardListIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1">Plan</span>
            <span className="font-medium tabular-nums text-foreground">
              {String(props.activePlanProgress.completed).padStart(planProgressWidth, "0")}/
              {String(props.activePlanProgress.total).padStart(planProgressWidth, "0")}
            </span>
          </button>
        ) : null}
        {activeTodoProgress ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent/60 hover:text-accent-foreground"
            onClick={props.onOpenSummaryPanel}
          >
            <ListTodoIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {activeTodoProgress.currentStep ?? "Todo"}
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {String(activeTodoProgress.currentIndex).padStart(todoProgressWidth, "0")}/
              {String(activeTodoProgress.total).padStart(todoProgressWidth, "0")}
            </span>
          </button>
        ) : null}
        {props.branchToolbarProps ? (
          <BranchToolbar {...props.branchToolbarProps} presentation="environment" />
        ) : null}
      </div>

      {props.isGitRepo ? (
        <div className="mt-1">
          <EnvironmentGitSection
            activeThreadId={props.activeThreadId}
            gitCwd={props.gitCwd}
            workspaceMode={props.workspaceMode}
            onWorkspaceModeChange={props.onWorkspaceModeChange}
          />
        </div>
      ) : null}

      {props.activeProjectScripts && props.activeProjectScripts.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <div className="mb-1 px-2 text-[12px] font-medium text-muted-foreground">Tasks</div>
          <ProjectScriptsControl
            scripts={props.activeProjectScripts}
            keybindings={props.keybindings}
            preferredScriptId={props.preferredScriptId}
            onRunScript={props.onRunProjectScript}
            onAddScript={props.onAddProjectScript}
            onUpdateScript={props.onUpdateProjectScript}
            onDeleteScript={props.onDeleteProjectScript}
          />
        </div>
      ) : null}

      {activeSubagentThreads.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <div className="mb-1 px-2 text-[12px] font-medium text-muted-foreground">Subagents</div>
          <div className="space-y-1">
            {activeSubagentThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="group/subagent flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  props.onSelectSubagentThread(thread.id);
                  props.onSubagentPanelOpen();
                }}
              >
                <SubagentPersonaIcon className="size-6" status={thread.status} thread={thread} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{thread.label}</span>
                  {formatSubagentSubtitle(thread) ? (
                    <span className="block truncate text-[11px] text-muted-foreground group-hover/subagent:text-accent-foreground/70">
                      {formatSubagentSubtitle(thread)}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-normal",
                    thread.status === "running" && "bg-sky-500/12 text-sky-500",
                    thread.status === "completed" && "bg-emerald-500/12 text-emerald-500",
                    thread.status === "failed" && "bg-destructive/12 text-destructive",
                  )}
                >
                  {statusLabel(thread.status)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </m.aside>
  );
});
