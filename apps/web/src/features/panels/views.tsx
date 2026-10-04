import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { AgentsTab } from "./agents/agents-tab.tsx";
import { ChangesTab } from "./changes/changes-tab.tsx";
import { hideLogLines } from "./logs/cleared.ts";
import { LogsTab, useThreadLog } from "./logs/logs-tab.tsx";
import { PreviewTab } from "./preview/preview-tab.tsx";
import { usePanelServices } from "./services.ts";
import { WithServices } from "./with-services.tsx";
import { TerminalTab, useOpenTerminal } from "./terminal/terminal-tab.tsx";

/*
 * The thread's tools as workspace tab views, loaded as one chunk the first time a dock shows one
 * (ADR 0056 route budget). Each adapts an existing tab to `TabViewProps`; the scope is the
 * thread id.
 */

function adapt(
  Tab: ComponentType<{ threadId: string }>,
  needsServices = true,
): ComponentType<TabViewProps> {
  const View = (props: TabViewProps) =>
    needsServices ? (
      <WithServices>
        <Tab threadId={props.scope} />
      </WithServices>
    ) : (
      <Tab threadId={props.scope} />
    );
  return View;
}

/** Changes, scrolled to the file the tab was opened on (`data.path`), if any. */
export function ChangesView(props: TabViewProps) {
  const data = props.tab.data;
  const path =
    typeof data === "object" && data !== null && "path" in data && typeof data.path === "string"
      ? data.path
      : undefined;
  return (
    <WithServices>
      <ChangesTab threadId={props.scope} path={path} />
    </WithServices>
  );
}
export const PreviewView = adapt(PreviewTab);
export const AgentsView = adapt(AgentsTab, false);
export const TerminalView = adapt(TerminalTab);
export const LogsView = adapt(LogsTab);

/** New terminal and Clear, beside the Terminal tab. */
export function TerminalActions(props: TabViewProps) {
  return (
    <WithServices quiet>
      <TerminalButtons threadId={props.scope} />
    </WithServices>
  );
}

function TerminalButtons(props: { threadId: string }) {
  const { terminals } = usePanelServices();
  const opener = useOpenTerminal(props.threadId);
  return (
    <>
      {opener.ready && (
        <IconButton
          icon={PlusIcon}
          label="New terminal"
          size="sm"
          className="size-7"
          onClick={opener.open}
        />
      )}
      <IconButton
        icon={TrashIcon}
        label="Clear terminal"
        size="sm"
        className="size-7"
        onClick={() => {
          // Your own terminals clear; an agent's background shell keeps its output.
          const shown = terminals.shown(props.threadId);
          if (shown && !shown.startsWith("task:")) terminals.clear(shown);
        }}
      />
    </>
  );
}

/** Clear, beside the Logs tab: hides the lines shown so far (Show brings them back). */
export function LogsActions(props: TabViewProps) {
  return (
    <WithServices quiet>
      <LogsButtons threadId={props.scope} />
    </WithServices>
  );
}

function LogsButtons(props: { threadId: string }) {
  const services = usePanelServices();
  const lines = useThreadLog(props.threadId);
  return (
    <IconButton
      icon={TrashIcon}
      label="Clear logs"
      size="sm"
      className="size-7"
      disabled={!lines.length}
      onClick={() =>
        hideLogLines(
          services.logCleared,
          props.threadId,
          lines.map((line) => line.key),
        )
      }
    />
  );
}
