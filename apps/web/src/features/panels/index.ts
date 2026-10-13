/**
 * The thread's workspace: its tab kinds (Changes, Terminal, Preview, Devices, Agents, Logs, the
 * new-tab launcher) and the definition the thread screen hands to `<Screen workspace>`.
 */
import { deferredComponent } from "@/lib/deferred-component.tsx";

export { threadWorkspace } from "./thread-workspace.ts";
/** Other slices' views the workspace tabs draw with (agent transcripts). */
export { ThreadPartsProvider, useThreadParts, type ThreadParts } from "./agents/thread-parts.ts";
/** A thread's agent work, and the subagent view's Stop. */
export { useTreeWork } from "./agents/use-tree-work.ts";
export { StopAgent } from "./agents/stop-agent.tsx";
export { countSubagents, findAgentNode } from "./agents/subagents.ts";
export { disposePanelServices, findRunningTerminal, useRunningTerminalNames } from "./services.ts";
export {
  newTerminal,
  openNewTerminal,
  shellLabel,
  shellTab,
  terminalTab,
} from "./terminal/tabs.ts";
export { useBackgroundShells } from "./terminal/use-terminals.ts";
/** A checkout file's tab, for whatever opens a file from outside the Files tool. */
export { fileTab } from "./files/tab-id.ts";
export { useScriptConfigurations } from "./files/script-configurations.ts";
export const loadCreateFile = () => import("./files/create-file.tsx");
/** A provider's sign-in terminal, outside any thread (the sign-in dialog shows it). */
export const loadAuthTerminal = () => import("./terminal/auth-terminal.tsx");
export type { AuthTerminalProps } from "./terminal/auth-terminal.tsx";

export const loadThreadBrowser = () => import("./browser/thread-browser.tsx");

/**
 * Shared, bounded diff rendering for hosted and local changes. Its code loads with the view that
 * shows a diff: re-exported from here it would join the first paint, which never draws one.
 */
export const DeferredFileDiffBlock = deferredComponent(() =>
  import("./changes/file-diff.tsx").then((module) => module.FileDiffBlock),
);
export const DeferredFileTree = deferredComponent(() =>
  import("./changes/file-tree.tsx").then((module) => module.FileTree),
);
export { freshView, type FileView } from "./changes/file-view.ts";
export type { LineRange, LineTarget } from "./changes/file-diff.tsx";
export { bindTerminalEndDelivery } from "./terminal/end-delivery.ts";
