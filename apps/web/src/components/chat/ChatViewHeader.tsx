import React, { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { AppPageTopBar } from "../AppPageTopBar";
import { ChatHeader } from "./ChatHeader";

export interface ChatViewHeaderProps {
  showThreadHeaderIdentity: boolean;
  isHeaderHidden: boolean;
  rightSidePanelFullscreen: boolean;
  showSidebarTrigger: boolean;
  paneControls: ReactNode | null;
  activeThreadTitle: string;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  environmentPanelOpen: boolean;
  rightSidePanelToggleShortcutLabel: string | null;
  rightSidePanelOpen: boolean;
  menuActions?: React.ComponentProps<typeof ChatHeader>["menuActions"];
  pinnedThread: boolean;
  onUnpinThread: () => void;
  onToggleEnvironmentPanel: () => void;
  onToggleTerminal: () => void;
  onToggleRightSidePanel: () => void;
  reliabilitySlot: ReactNode;
  dockedRightSidePanelHeader: ReactNode;
  fullscreenRightSidePanelHeader: ReactNode;
}

export const ChatViewHeader = React.memo(function ChatViewHeader({
  showThreadHeaderIdentity,
  isHeaderHidden,
  rightSidePanelFullscreen,
  showSidebarTrigger,
  paneControls,
  activeThreadTitle,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  environmentPanelOpen,
  rightSidePanelToggleShortcutLabel,
  rightSidePanelOpen,
  menuActions,
  pinnedThread,
  onUnpinThread,
  onToggleEnvironmentPanel,
  onToggleTerminal,
  onToggleRightSidePanel,
  reliabilitySlot,
  dockedRightSidePanelHeader,
  fullscreenRightSidePanelHeader,
}: ChatViewHeaderProps) {
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-stretch overflow-hidden bg-background transition-[max-height,opacity] duration-200 ease-out",
        showThreadHeaderIdentity &&
          "border-b border-border/25 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/70",
        isHeaderHidden ? "max-h-0 opacity-0" : "max-h-28 opacity-100",
      )}
    >
      <AppPageTopBar
        className={cn("min-w-0 flex-1", !showThreadHeaderIdentity && "border-b-0")}
        desktopDragRegion={!rightSidePanelFullscreen}
        showSidebarTrigger={showSidebarTrigger}
      >
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          {paneControls ? (
            <div className="mr-1 flex shrink-0 items-center gap-0.5">{paneControls}</div>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">
            <ChatHeader
              activeThreadTitle={activeThreadTitle}
              terminalAvailable={terminalAvailable}
              terminalOpen={terminalOpen}
              terminalToggleShortcutLabel={terminalToggleShortcutLabel}
              environmentPanelOpen={environmentPanelOpen}
              rightSidePanelToggleShortcutLabel={rightSidePanelToggleShortcutLabel}
              rightSidePanelOpen={rightSidePanelOpen}
              {...(menuActions !== undefined && { menuActions })}
              pinnedThread={pinnedThread}
              showThreadIdentity={showThreadHeaderIdentity}
              onUnpinThread={onUnpinThread}
              onToggleEnvironmentPanel={onToggleEnvironmentPanel}
              onToggleTerminal={onToggleTerminal}
              onToggleRightSidePanel={onToggleRightSidePanel}
              reliabilitySlot={reliabilitySlot}
            />
          </div>
        </div>
      </AppPageTopBar>
      {dockedRightSidePanelHeader}
      {fullscreenRightSidePanelHeader}
    </div>
  );
});
