import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useThreadLog } from "./logs/logs-tab.tsx";
import { usePanelServices } from "./services.ts";
import { useOpenTerminal } from "./terminal/terminal-tab.tsx";

/** New terminal (Terminal tab only) and Clear, for whichever bottom tab is showing. */
export function BottomActions(props: { threadId: string }) {
  const { layout } = useLayout();
  const services = usePanelServices();
  const opener = useOpenTerminal(props.threadId);
  const lines = useThreadLog(props.threadId);
  const sessions = services.terminals;
  const terminal = layout.bottom.tab !== "logs";
  const clear = () => {
    if (!terminal) {
      if (lines.length)
        services.logCleared.set((previous) =>
          new Map(previous).set(props.threadId, new Set(lines.map((line) => line.key))),
        );
    } else {
      const shown = sessions.shown(props.threadId);
      if (shown && !shown.startsWith("task:")) sessions.clear(shown);
    }
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
