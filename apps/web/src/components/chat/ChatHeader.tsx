import {
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@ace/contracts";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import {
  BugIcon,
  ChevronsUpIcon,
  DiffIcon,
  GlobeIcon,
  SquarePenIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import { TopBarCluster, interleaveTopBarItems } from "../thread/TopBarCluster";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectId: ProjectId | null;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  sidebarToggleShortcutLabel: string | null;
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
  onHideHeader: () => void;
  hideHeaderShortcutLabel: string | null;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectId,
  activeProjectName,
  isGitRepo,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  sidebarToggleShortcutLabel,
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
  onHideHeader,
  hideHeaderShortcutLabel,
}: ChatHeaderProps) {
  const { isMobile, state } = useSidebar();
  const showSidebarToggle = isMobile || state === "collapsed";
  const editorWorkspaceActive = workspaceMode === "editor" || workspaceMode === "split";
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
  const utilityToggleClassName =
    "shrink-0 rounded-full border border-transparent text-foreground/60 hover:text-foreground/85 data-[pressed]:border-border/45 data-[pressed]:text-foreground disabled:text-foreground/25";
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
            <TerminalSquareIcon className="size-3.5" />
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
    <Tooltip key="hide-header">
      <TooltipTrigger
        render={
          <Button
            className={utilityToggleClassName}
            onClick={onHideHeader}
            aria-label="Hide top header"
            variant="default"
            size="xs"
          >
            <ChevronsUpIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {hideHeaderShortcutLabel
          ? `Hide top header (${hideHeaderShortcutLabel})`
          : "Hide top header"}
      </TooltipPopup>
    </Tooltip>,
  ]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
        {showSidebarToggle ? (
          <Tooltip>
            <TooltipTrigger
              render={<SidebarTrigger className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME} />}
            />
            <TooltipPopup side="bottom">
              {sidebarToggleShortcutLabel
                ? `Toggle sidebar (${sidebarToggleShortcutLabel})`
                : "Toggle sidebar"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {workspaceMode === "editor" ? (
          <span
            className="min-w-0 truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80"
            title={workspaceName ?? activeProjectName}
          >
            {workspaceName ?? activeProjectName ?? "Workspace"}
          </span>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <h2
              className="min-w-0 shrink truncate text-[13px] leading-none font-medium tracking-tight text-foreground/80"
              title={activeThreadTitle}
            >
              {activeThreadTitle}
            </h2>
            {activeProjectName ? (
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
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
                    className="min-w-0 max-w-48 shrink overflow-hidden border-border/15 bg-muted/15 text-muted-foreground/45"
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

      <div className="flex shrink-0 items-center gap-1.5">
        {workspaceActionNodes.length > 0 ? (
          <div className="flex min-w-0 items-center gap-1.5">{workspaceActionNodes}</div>
        ) : null}
        <TopBarCluster>{utilityItems}</TopBarCluster>
      </div>
    </div>
  );
});
