import {
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@ace/contracts";
import { IconTerminal } from "@tabler/icons-react";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import {
  BugIcon,
  DiffIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  SquarePenIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import {
  HEADER_PILL_TOGGLE_CONTROL_CLASS_NAME,
  TopBarCluster,
  interleaveTopBarItems,
} from "../thread/TopBarCluster";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

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
  diffToggleShortcutLabel,
  browserToggleShortcutLabel,
  browserAvailable,
  browserOpen,
  browserDevToolsOpen,
  gitCwd,
  diffOpen,
  workspaceMode,
  workspaceName,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onOpenBrowser,
  onCloseBrowser,
  onActiveProjectChange,
  onToggleTerminal,
  onToggleDiff,
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
  const utilityToggleClassName = `shrink-0 ${HEADER_PILL_TOGGLE_CONTROL_CLASS_NAME}`;
  const utilityItems = interleaveTopBarItems([
    <Tooltip key="editor-workspace">
      <TooltipTrigger
        render={
          <Toggle
            className={utilityToggleClassName}
            pressed={editorWorkspaceActive}
            onPressedChange={(pressed) => {
              onWorkspaceModeChange(pressed ? "editor" : "chat");
            }}
            aria-pressed={editorWorkspaceActive}
            aria-label="Editor workspace"
            variant="default"
            size="xs"
          >
            <SquarePenIcon className="size-3.5" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {editorWorkspaceActive ? "Leave editor — return to chat" : "Open editor workspace"}
      </TooltipPopup>
    </Tooltip>,
    browserAvailable ? (
      <Tooltip key="browser">
        <TooltipTrigger
          render={
            <Toggle
              className={utilityToggleClassName}
              pressed={browserOpen}
              onPressedChange={(pressed) => {
                if (pressed) {
                  onOpenBrowser();
                  return;
                }
                onCloseBrowser();
              }}
              aria-label={browserOpen ? "Close in-app browser" : "Open in-app browser"}
              variant="default"
              size="xs"
            >
              <span className="relative flex items-center justify-center">
                <GlobeIcon className="size-3.5" />
                {browserOpen && browserDevToolsOpen ? (
                  <span className="absolute -top-1 -right-1 flex size-2 items-center justify-center rounded-full bg-amber-500">
                    <BugIcon className="size-1.5 text-amber-950" />
                  </span>
                ) : null}
              </span>
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {browserOpen
            ? browserToggleShortcutLabel
              ? `${browserDevToolsOpen ? "Close in-app browser · DevTools open" : "Close in-app browser"} (${browserToggleShortcutLabel})`
              : browserDevToolsOpen
                ? "Close in-app browser · DevTools open"
                : "Close in-app browser"
            : browserToggleShortcutLabel
              ? `Open in-app browser (${browserToggleShortcutLabel})`
              : "Open in-app browser"}
        </TooltipPopup>
      </Tooltip>
    ) : null,
    <Tooltip key="terminal">
      <TooltipTrigger
        render={
          <Toggle
            className={utilityToggleClassName}
            pressed={terminalOpen}
            onPressedChange={onToggleTerminal}
            aria-label="Toggle terminal drawer"
            variant="default"
            size="xs"
            disabled={!terminalAvailable}
          >
            <IconTerminal className="size-3.5" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!terminalAvailable
          ? "Terminal is unavailable until this thread has an active project."
          : terminalToggleShortcutLabel
            ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
            : "Toggle terminal drawer"}
      </TooltipPopup>
    </Tooltip>,
    <Tooltip key="diff">
      <TooltipTrigger
        render={
          <Toggle
            className={utilityToggleClassName}
            pressed={diffOpen}
            onPressedChange={onToggleDiff}
            aria-label="Toggle diff panel"
            variant="default"
            size="xs"
            disabled={!isGitRepo}
          >
            <DiffIcon className="size-3.5" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!isGitRepo
          ? "Diff panel is unavailable because this project is not a git repository."
          : diffToggleShortcutLabel
            ? `Toggle diff panel (${diffToggleShortcutLabel})`
            : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>,
  ]);

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

      <div className="flex shrink-0 items-center gap-0.75 overflow-x-auto sm:gap-1">
        {workspaceActionNodes.length > 0 ? (
          <div className="flex min-w-0 items-center gap-0.75 sm:gap-1">{workspaceActionNodes}</div>
        ) : null}
        <TopBarCluster>{utilityItems}</TopBarCluster>
      </div>
    </div>
  );
});
