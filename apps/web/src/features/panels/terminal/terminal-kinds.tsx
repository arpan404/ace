import { TerminalIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { defineTabKind, type ClosingTab, type CloseWarning } from "@/lib/workspace/index.ts";
import { OutputSkeleton } from "../tab-skeletons.tsx";
import { requestTerminalEnd, terminalEnded } from "./closing.ts";
import {
  isPendingTerminal,
  shellKind as shellKindId,
  terminalKind as terminalKindId,
} from "./tabs.ts";

/*
 * Terminals and agent shells as workspace tabs (see `tabs.ts` for their ids). Each kind's view
 * loads in its own chunk the first time one of its tabs shows; xterm loads after that.
 */

export const terminalKind = defineTabKind({
  kind: terminalKindId,
  label: "Terminal",
  icon: TerminalWindowIcon,
  docks: ["bottom", "right"],
  launcher: 20,
  title: (tab) => tab.title ?? "Terminal",
  Skeleton: OutputSkeleton,
  load: () =>
    import("./terminal-resource.tsx").then((m) => ({
      default: m.default,
      Actions: m.TerminalActions,
    })),
  // Your terminal: closing its tab ends its shell. Hiding the dock never does.
  onClose: (scope, tab) => {
    if (!isPendingTerminal(tab.id)) requestTerminalEnd({ threadId: scope, terminalId: tab.id });
  },
  closeLabel: "End session",
  closeWarning: endWarning,
  // Its shell ended with the tab: there is nothing to come back to.
  reopenable: () => false,
});

/** Ask before ending shells that may still run something (a dev server, a build). */
function endWarning(scope: string, tabs: readonly ClosingTab[]): CloseWarning | undefined {
  const live = tabs.filter(
    ({ tab }) => !isPendingTerminal(tab.id) && !terminalEnded(scope, tab.id),
  );
  const first = live[0];
  if (!first) return undefined;
  // Kept on one line with its brackets.
  const hide = (
    <span className="whitespace-nowrap">
      (
      <Kbd
        shortcut={first.dock === "bottom" ? "bottomPanel" : "rightPanel"}
        variant="bare"
        className="h-auto min-w-0 px-0 text-ui text-current"
      />
      )
    </span>
  );
  if (live.length === 1)
    return {
      title: `End ${first.title}?`,
      description: (
        <>Its shell and anything running in it stop. Hide the panel {hide} to keep it running.</>
      ),
      confirm: "End",
    };
  const names = live.map((each) => each.title);
  const listed = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    title: `End ${live.length} shells?`,
    description: (
      <>
        Closing them ends {listed}, and anything running in them. Hide the panel {hide} to keep them
        running.
      </>
    ),
    confirm: `End ${live.length} shells`,
  };
}

export const shellKind = defineTabKind({
  kind: shellKindId,
  label: "Agent shell",
  icon: TerminalIcon,
  docks: ["bottom", "right"],
  title: (tab) => tab.title ?? "Agent shell",
  Skeleton: OutputSkeleton,
  // The agent's shell keeps running when its tab closes; Stop is in the tab.
  load: () =>
    import("./shell-resource.tsx").then((m) => ({ default: m.default, Actions: m.ShellActions })),
});
