import { TerminalIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { defineTabKind } from "@/lib/workspace/index.ts";
import { requestTerminalEnd } from "./closing.ts";
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
  load: () =>
    import("./terminal-resource.tsx").then((m) => ({
      default: m.default,
      Actions: m.TerminalActions,
    })),
  // Your terminal: closing its tab ends its shell. Hiding the dock never does.
  onClose: (scope, tab) => {
    if (!isPendingTerminal(tab.id)) requestTerminalEnd({ threadId: scope, terminalId: tab.id });
  },
});

export const shellKind = defineTabKind({
  kind: shellKindId,
  label: "Agent shell",
  icon: TerminalIcon,
  docks: ["bottom", "right"],
  title: (tab) => tab.title ?? "Agent shell",
  // The agent's shell keeps running when its tab closes; Stop is in the tab.
  load: () =>
    import("./shell-resource.tsx").then((m) => ({ default: m.default, Actions: m.ShellActions })),
});
