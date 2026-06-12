import { type ProjectId } from "@ace/contracts";
import { IconLayoutSidebarRight, IconLayoutSidebarRightFilled } from "@tabler/icons-react";
import { Settings2Icon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadTitle: string;
  activeProjectId: ProjectId | null;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  environmentPanelOpen: boolean;
  rightSidePanelToggleShortcutLabel: string | null;
  rightSidePanelOpen: boolean;
  onActiveProjectChange?: ((projectId: ProjectId) => void) | null;
  onToggleEnvironmentPanel: () => void;
  onToggleTerminal: () => void;
  onToggleRightSidePanel: () => void;
  reliabilitySlot?: ReactNode;
  showThreadIdentity?: boolean;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadTitle,
  activeProjectId,
  activeProjectName,
  isGitRepo,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  environmentPanelOpen,
  rightSidePanelToggleShortcutLabel,
  rightSidePanelOpen,
  onActiveProjectChange,
  onToggleEnvironmentPanel,
  onToggleTerminal,
  onToggleRightSidePanel,
  reliabilitySlot,
  showThreadIdentity = true,
}: ChatHeaderProps) {
  const bottomPanelTooltipLabel = !terminalAvailable
    ? "Bottom panel is unavailable until this thread has an active project."
    : terminalToggleShortcutLabel
      ? `Toggle bottom panel (${terminalToggleShortcutLabel})`
      : "Toggle bottom panel";
  const rightSidePanelTooltipLabel = `${rightSidePanelOpen ? "Close" : "Open"} panel${
    rightSidePanelToggleShortcutLabel ? ` (${rightSidePanelToggleShortcutLabel})` : ""
  }`;
  const rightSidePanelButtonLabel = rightSidePanelToggleShortcutLabel
    ? `Toggle panel (${rightSidePanelToggleShortcutLabel})`
    : "Toggle panel";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2">
        {showThreadIdentity ? (
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="heading"
                    aria-level={2}
                    className="flex min-w-0 shrink items-center truncate text-[13px] leading-[18px] font-medium tracking-tight text-foreground/80"
                  >
                    {activeThreadTitle}
                  </span>
                }
              />
              <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
                {activeThreadTitle}
              </TooltipPopup>
            </Tooltip>
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
                    className="min-w-0 max-w-40 shrink overflow-hidden border-pill-border/40 bg-pill/80 text-pill-foreground/65 sm:max-w-48"
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
        ) : null}
      </div>

      <div className="flex shrink-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex shrink-0 items-center gap-1.5">
          {reliabilitySlot}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
                    environmentPanelOpen && "!bg-accent text-foreground hover:text-foreground",
                  )}
                  onClick={onToggleEnvironmentPanel}
                  aria-pressed={environmentPanelOpen}
                  aria-label="Toggle environment panel"
                />
              }
            >
              <Settings2Icon className="size-[18px]" strokeWidth={2} />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="end">
              Environment
            </TooltipPopup>
          </Tooltip>
          {!rightSidePanelOpen ? (
            <>
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
                          ? `Toggle bottom panel (${terminalToggleShortcutLabel})`
                          : "Toggle bottom panel"
                      }
                    />
                  }
                >
                  {terminalOpen ? (
                    <IconLayoutSidebarRightFilled className="size-[18px] rotate-90" />
                  ) : (
                    <IconLayoutSidebarRight className="size-[18px] rotate-90" strokeWidth={2} />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="bottom" align="end">
                  {bottomPanelTooltipLabel}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME}
                      onClick={onToggleRightSidePanel}
                      aria-pressed={false}
                      aria-label={rightSidePanelButtonLabel}
                    />
                  }
                >
                  <IconLayoutSidebarRight className="size-[18px]" strokeWidth={2} />
                </TooltipTrigger>
                <TooltipPopup side="bottom" align="end">
                  {rightSidePanelTooltipLabel}
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
});
