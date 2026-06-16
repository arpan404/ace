import { type ProjectId } from "@ace/contracts";
import { memo, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PremiumEnvironmentIcon, PremiumPanelIcon } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectContextSwitcher } from "./ProjectContextSwitcher";
import { DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME } from "~/lib/desktopChrome";
import { cn } from "~/lib/utils";

const CHAT_HEADER_PANEL_BUTTON_CLASS_NAME = cn(
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
  "size-8.5 rounded-xl text-foreground/42 transition-[background-color,border-color,box-shadow,color,transform] duration-150 ease-out hover:!bg-foreground/[0.055] hover:text-foreground/74 active:scale-[0.98] active:!bg-foreground/[0.075] [&_svg]:size-[19px] [&_svg]:drop-shadow-[0_1px_0_rgba(255,255,255,0.08)]",
);

const CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME =
  "!border-white/[0.075] !bg-foreground/[0.095] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_18px_rgba(0,0,0,0.16)] hover:!bg-foreground/[0.12] hover:text-foreground";

const CHAT_HEADER_PANEL_ICON_CLASS_NAME = "size-5";

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

export function ChatHeader({
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
                  <h2 className="m-0 flex min-w-0 shrink items-center truncate text-[13px] leading-[18px] font-medium tracking-tight text-foreground/80">
                    {activeThreadTitle}
                  </h2>
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
        <div className="flex shrink-0 items-center gap-0.5">
          {reliabilitySlot}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn(
                    CHAT_HEADER_PANEL_BUTTON_CLASS_NAME,
                    environmentPanelOpen && CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME,
                  )}
                  onClick={onToggleEnvironmentPanel}
                  aria-pressed={environmentPanelOpen}
                  aria-label="Toggle environment panel"
                />
              }
            >
              <PremiumEnvironmentIcon className={CHAT_HEADER_PANEL_ICON_CLASS_NAME} />
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
                        CHAT_HEADER_PANEL_BUTTON_CLASS_NAME,
                        terminalOpen && CHAT_HEADER_PANEL_BUTTON_ACTIVE_CLASS_NAME,
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
                  <PremiumPanelIcon
                    className={CHAT_HEADER_PANEL_ICON_CLASS_NAME}
                    open={terminalOpen}
                    side="bottom"
                  />
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
                      className={CHAT_HEADER_PANEL_BUTTON_CLASS_NAME}
                      onClick={onToggleRightSidePanel}
                      aria-pressed={false}
                      aria-label={rightSidePanelButtonLabel}
                    />
                  }
                >
                  <PremiumPanelIcon
                    className={CHAT_HEADER_PANEL_ICON_CLASS_NAME}
                    open={false}
                    side="right"
                  />
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
}
