import type { ThreadId } from "@ace/contracts";
import { useShallow } from "zustand/react/shallow";

import {
  selectThreadTerminalState,
  type TerminalPanelPlacement,
  useTerminalStateStore,
} from "../../terminalStateStore";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";

export interface ConnectedThreadTerminalPanelProps {
  activeThreadId: ThreadId;
  activeProjectAvailable: boolean;
  cwd: string | null;
  runtimeEnv: Record<string, string> | undefined;
  focusRequestId: number;
  interactive: boolean;
  newShortcutLabel?: string | undefined;
  toggleShortcutLabel?: string | undefined;
  placement: TerminalPanelPlacement;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onCloseTerminal: (terminalId: string) => void;
  onToggleTerminal: () => void;
  onClosePanelTerminal: () => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void | Promise<void>) | null;
}

export function ConnectedThreadTerminalPanel({
  placement,
  activeThreadId,
  activeProjectAvailable,
  cwd,
  runtimeEnv,
  focusRequestId,
  interactive,
  newShortcutLabel,
  toggleShortcutLabel,
  onNewTerminal,
  onActiveTerminalChange,
  onMoveTerminal,
  onSplitRatiosChange,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onClosePanelTerminal,
  onHeightChange,
  onAddTerminalContext,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
}: ConnectedThreadTerminalPanelProps) {
  const terminalDrawerState = useTerminalStateStore(
    useShallow((state) => {
      const selectedThreadState = selectThreadTerminalState(
        state.terminalStateByThreadId,
        activeThreadId,
      );
      const selectedPanelState = selectedThreadState.terminalPanelStateByPlacement[placement];
      return {
        terminalHeight: selectedPanelState.terminalHeight,
        terminalIds: selectedPanelState.terminalIds,
        activeTerminalId: selectedPanelState.activeTerminalId,
        terminalGroups: selectedPanelState.terminalGroups,
        runningTerminalIds: selectedThreadState.runningTerminalIds,
        autoTerminalTitlesById: selectedThreadState.autoTerminalTitlesById,
        splitRatiosByGroupId: selectedPanelState.splitRatiosByGroupId,
      };
    }),
  );

  if (!activeProjectAvailable || !cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-terminal px-4 text-center text-[13px] text-muted-foreground">
        Terminal is unavailable until this thread has an active project.
      </div>
    );
  }

  return (
    <ThreadTerminalDrawer
      threadId={activeThreadId}
      cwd={cwd}
      {...(runtimeEnv ? { runtimeEnv } : {})}
      layout="panel"
      height={terminalDrawerState.terminalHeight}
      terminalIds={terminalDrawerState.terminalIds}
      activeTerminalId={terminalDrawerState.activeTerminalId}
      terminalGroups={terminalDrawerState.terminalGroups}
      runningTerminalIds={terminalDrawerState.runningTerminalIds}
      autoTerminalTitlesById={terminalDrawerState.autoTerminalTitlesById}
      splitRatiosByGroupId={terminalDrawerState.splitRatiosByGroupId}
      focusRequestId={focusRequestId}
      interactive={interactive}
      onNewTerminal={onNewTerminal}
      newShortcutLabel={newShortcutLabel}
      toggleShortcutLabel={toggleShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onMoveTerminal={onMoveTerminal}
      onSplitRatiosChange={onSplitRatiosChange}
      onAutoTerminalTitleChange={onAutoTerminalTitleChange}
      onCloseTerminal={onCloseTerminal}
      onToggleTerminal={onClosePanelTerminal}
      onHeightChange={onHeightChange}
      onAddTerminalContext={onAddTerminalContext}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenFilePath={onOpenFilePath}
    />
  );
}
