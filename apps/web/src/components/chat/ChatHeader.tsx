import {
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@ace/contracts";
import {
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
  IconTerminal,
} from "@tabler/icons-react";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import { FolderIcon, GitBranchIcon, GitForkIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadBranch: string | null;
  activeThreadWorktreePath: string | null;
  activeThreadTitle: string;
  activeProjectId: ProjectId | null;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  browserToggleShortcutLabel: string | null;
  browserAvailable: boolean;
  browserOpen: boolean;
  browserDevToolsOpen: boolean;
  gitCwd: string | null;
  diffOpen: boolean;
  rightSidePanelOpen: boolean;
  workspaceMode: ThreadWorkspaceMode;
  workspaceName: string | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onOpenBrowser: () => void;
  onCloseBrowser: () => void;
  onActiveProjectChange?: ((projectId: ProjectId) => void) | null;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onToggleRightSidePanel: () => void;
  onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadBranch,
  activeThreadWorktreePath,
  activeThreadTitle,
  activeProjectId,
  activeProjectName,
  isGitRepo,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  rightSidePanelOpen,
  gitCwd,
  workspaceMode,
  workspaceName,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onActiveProjectChange,
  onToggleTerminal,
  onToggleRightSidePanel,
  onWorkspaceModeChange,
}: ChatHeaderProps) {
  const editorWorkspaceActive = workspaceMode === "editor" || workspaceMode === "split";
  const workspaceDisplayName = workspaceName ?? activeProjectName ?? "Workspace";
  const workspaceActionItems: ReactNode[] = [
    activeProjectScripts ? (
      <ProjectScriptsControl
        key="scripts"
        scripts={activeProjectScripts}
        keybindings={keybindings}
        preferredScriptId={preferredScriptId}
        onRunScript={onRunProjectScript}
        onAddScript={onAddProjectScript}
        onUpdateScript={onUpdateProjectScript}
        onDeleteScript={onDeleteProjectScript}
      />
    ) : null,
    activeProjectName ? (
      <GitActionsControl
        key="git"
        gitCwd={gitCwd}
        activeThreadId={activeThreadId}
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={onWorkspaceModeChange}
      />
    ) : null,
  ];
  const workspaceActionNodes = workspaceActionItems.filter(
    (item): item is NonNullable<ReactNode> => item !== null,
  );
  const terminalTooltipLabel = !terminalAvailable
    ? "Terminal is unavailable until this thread has an active project."
    : terminalToggleShortcutLabel
      ? `Toggle terminal (${terminalToggleShortcutLabel})`
      : "Toggle terminal";
  const rightSidePanelTooltipLabel = rightSidePanelOpen
    ? "Close right side panel"
    : "Open right side panel";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2">
        {editorWorkspaceActive ? (
          <div
            className="flex min-w-0 max-w-full items-center gap-2.5"
            title={workspaceDisplayName}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-foreground/72">
              <FolderIcon className="size-4" />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-[13px] leading-none font-medium tracking-tight text-foreground/84">
                {workspaceDisplayName}
              </span>
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] leading-none text-muted-foreground/72">
                {activeThreadBranch ? (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate">
                    <GitBranchIcon className="size-3 shrink-0" />
                    <span className="truncate">{activeThreadBranch}</span>
                  </span>
                ) : null}
                {activeThreadWorktreePath ? (
                  <span className="inline-flex items-center gap-1" title={activeThreadWorktreePath}>
                    <GitForkIcon className="size-3 shrink-0" />
                    <span>Worktree</span>
                  </span>
                ) : null}
                {!activeThreadBranch && !activeThreadWorktreePath ? (
                  <span className="truncate">Editor workspace</span>
                ) : null}
              </span>
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <h2
              className="min-w-0 shrink truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80"
              title={activeThreadTitle}
            >
              {activeThreadTitle}
            </h2>
            {activeProjectName ? (
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {activeProjectId !== null && onActiveProjectChange ? (
                  <ProjectContextSwitcher
                    activeProjectId={activeProjectId}
                    className="min-w-0 max-w-52 shrink"
                    onSelectProject={onActiveProjectChange}
                  />
                ) : (
                  <Badge
                    variant="outline"
                    size="sm"
                    className="min-w-0 max-w-40 shrink overflow-hidden border-pill-border/70 bg-pill/88 text-pill-foreground/65 sm:max-w-48"
                  >
                    <span className="min-w-0 truncate">{activeProjectName}</span>
                  </Badge>
                )}
                {!isGitRepo ? (
                  <Badge variant="warning" size="sm" className="shrink-0">
                    No Git
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {workspaceActionNodes.length > 0 ? (
          <>
            <div className="flex min-w-0 items-center gap-0.75 sm:gap-1">
              {workspaceActionNodes}
            </div>
            <div className="mx-3 h-4 w-0.5 shrink-0 rounded-full bg-border/80" aria-hidden="true" />
          </>
        ) : null}
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
                    terminalOpen && "!bg-accent text-foreground hover:text-foreground",
                  )}
                  onClick={onToggleTerminal}
                  disabled={!terminalAvailable}
                  aria-pressed={terminalOpen}
                  aria-label={
                    terminalToggleShortcutLabel
                      ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                      : "Toggle terminal drawer"
                  }
                />
              }
            >
              <IconTerminal className="size-[18px]" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              {terminalTooltipLabel}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
                    rightSidePanelOpen && "!bg-accent text-foreground hover:text-foreground",
                  )}
                  onClick={onToggleRightSidePanel}
                  aria-pressed={rightSidePanelOpen}
                  aria-label="Toggle right side panel"
                />
              }
            >
              {rightSidePanelOpen ? (
                <IconLayoutSidebarRightFilled className="size-[18px]" />
              ) : (
                <IconLayoutSidebarRight className="size-[18px]" strokeWidth={2} />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              {rightSidePanelTooltipLabel}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
