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
    <aside className="pointer-events-auto relative z-30 mr-3 mt-3 hidden max-h-[calc(100%-1.5rem)] w-72 shrink-0 self-start overflow-y-auto rounded-2xl border border-border/70 bg-popover/90 p-3 text-popover-foreground shadow-2xl shadow-black/10 backdrop-blur-xl lg:block">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium text-muted-foreground">Environment</h2>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Environment settings"
        >
          <SettingsIcon className="size-4" />
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex min-h-8 items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
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

      {props.subagentThreads.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <div className="mb-1 px-2 text-[12px] font-medium text-muted-foreground">Subagents</div>
          <div className="space-y-1">
            {props.subagentThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  props.onSelectSubagentThread(thread.id);
                  props.onSubagentPanelOpen();
                }}
              >
                <BotIcon
                  className={
                    thread.status === "failed"
                      ? "size-3.5 text-destructive"
                      : thread.status === "running"
                        ? "size-3.5 text-sky-500"
                        : "size-3.5 text-emerald-500"
                  }
                />
                <span className="min-w-0 flex-1 truncate">{thread.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 border-t border-border/60 pt-2.5">
        <div className="px-2 text-[13px] font-medium text-muted-foreground">Sources</div>
        <div className="px-2 pt-1.5 text-[13px] text-muted-foreground">No sources yet</div>
      </div>
    </aside>
  );
}
