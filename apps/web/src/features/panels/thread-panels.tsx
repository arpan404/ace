import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Suspense, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { PanelDefinition } from "@/features/shell/panels.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { AgentsTab } from "./agents/agents-tab.tsx";
import { ChangesTab } from "./changes/changes-tab.tsx";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";
import { useThreadLog } from "./logs/logs-tab.tsx";
import { LogsTab } from "./logs/logs-tab.tsx";
import { PreviewTab } from "./preview/preview-tab.tsx";
import { usePanelServices } from "./services.ts";
import { TerminalTab, useOpenTerminal } from "./terminal/terminal-tab.tsx";

function Loading(props: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center">
          <Spinner label="Loading" />
        </div>
      }
    >
      {props.children}
    </Suspense>
  );
}

/**
 * A thread's right panel (Changes · Preview · Agents) and bottom panel (Terminal · Logs), as
 * data for `<Screen right bottom>`. The shell owns open state, sizes and the panel shortcuts.
 */
export function threadPanels(threadId: string): {
  right: PanelDefinition;
  bottom: PanelDefinition;
} {
  return {
    right: {
      label: "Thread panel",
      tabs: [
        {
          id: "changes",
          label: "Changes",
          badge: <ThreadDiffStat threadId={threadId} />,
          shortcut: "changes",
          content: (
            <Loading>
              <ChangesTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "preview",
          label: "Preview",
          content: (
            <Loading>
              <PreviewTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "agents",
          label: "Agents",
          shortcut: "agents",
          content: <AgentsTab threadId={threadId} />,
        },
      ],
    },
    bottom: {
      label: "Bottom panel",
      tabs: [
        {
          id: "terminal",
          label: "Terminal",
          content: (
            <Loading>
              <TerminalTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "logs",
          label: "Logs",
          content: (
            <Loading>
              <LogsTab threadId={threadId} />
            </Loading>
          ),
        },
      ],
      actions: (
        <Suspense>
          <BottomActions threadId={threadId} />
        </Suspense>
      ),
    },
  };
}

/** New terminal (Terminal tab only) and Clear, for whichever bottom tab is showing. */
function BottomActions(props: { threadId: string }) {
  const { layout } = useLayout();
  const services = usePanelServices();
  const opener = useOpenTerminal(props.threadId);
  const lines = useThreadLog(props.threadId);
  const sessions = services.terminals;
  const selected = useSyncExternalStore(sessions.watchSelection, () =>
    sessions.selection(props.threadId),
  );
  const terminal = layout.bottom.tab !== "logs";
  const clear = () => {
    if (!terminal) {
      const last = lines.at(-1);
      if (last)
        services.logCutoffs.set((previous) => new Map(previous).set(props.threadId, last.at));
    } else if (selected && !selected.startsWith("task:")) sessions.clear(selected);
  };
  return (
    <>
      {terminal && opener.ready && (
        <IconButton icon={PlusIcon} label="New terminal" size="sm" onClick={opener.open} />
      )}
      <IconButton
        icon={TrashIcon}
        label={terminal ? "Clear terminal" : "Clear logs"}
        size="sm"
        onClick={clear}
      />
    </>
  );
}
