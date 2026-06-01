import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@ace/contracts";
import { type ComponentProps } from "react";
import { BotIcon, SettingsIcon, SlidersHorizontalIcon } from "lucide-react";

import BranchToolbar from "../BranchToolbar";
import EnvironmentGitSection from "../EnvironmentGitSection";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import type { SubagentThread } from "./SubagentThreadsPanel";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

function formatDiffCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function EnvironmentMiniPanel(props: {
  activeProjectScripts: ProjectScript[] | undefined;
  activeSubagentThreadId: string | null;
  activeThreadId: ThreadId;
  branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
  gitCwd: string | null;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onRunProjectScript: (script: ProjectScript) => void;
  onSelectSubagentThread: (threadId: string) => void;
  onSubagentPanelOpen: () => void;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
  preferredScriptId: string | null;
  subagentThreads: ReadonlyArray<SubagentThread>;
  workspaceChangeStat: { additions: number; deletions: number } | null;
  workspaceMode: ThreadWorkspaceMode;
}) {
  const hasChanges =
    props.workspaceChangeStat !== null &&
    (props.workspaceChangeStat.additions > 0 || props.workspaceChangeStat.deletions > 0);
  const workspaceChangeStat = props.workspaceChangeStat;

  return (
    <aside className="pointer-events-auto absolute top-6 right-6 z-30 hidden w-80 max-w-[calc(100%-3rem)] rounded-3xl border border-border/70 bg-popover/90 p-4 text-popover-foreground shadow-2xl shadow-black/10 backdrop-blur-xl lg:block">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium text-muted-foreground">Environment</h2>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Environment settings"
        >
          <SettingsIcon className="size-4.5" />
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex min-h-9 items-center gap-3 rounded-lg px-2 py-1.5 text-[15px]">
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">Changes</span>
          {hasChanges && workspaceChangeStat ? (
            <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums">
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
            <span className="text-xs text-muted-foreground">Clean</span>
          )}
        </div>
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
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="mb-1 px-2 text-[13px] font-medium text-muted-foreground">Tasks</div>
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

      {props.subagentThreads.length > 0 ? (
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="mb-1 px-2 text-[13px] font-medium text-muted-foreground">Subagents</div>
          <div className="space-y-1">
            {props.subagentThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="flex min-h-9 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[15px] transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  props.onSelectSubagentThread(thread.id);
                  props.onSubagentPanelOpen();
                }}
              >
                <BotIcon
                  className={
                    thread.status === "failed"
                      ? "size-4 text-destructive"
                      : thread.status === "running"
                        ? "size-4 text-sky-500"
                        : "size-4 text-emerald-500"
                  }
                />
                <span className="min-w-0 flex-1 truncate">{thread.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="px-2 text-[15px] font-medium text-muted-foreground">Sources</div>
        <div className="px-2 pt-2 text-[15px] text-muted-foreground">No sources yet</div>
      </div>
    </aside>
  );
}
