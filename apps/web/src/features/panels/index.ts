/**
 * The thread's workspace: its tab kinds (Changes, Terminal, Preview, Devices, Agents, Logs, the
 * new-tab launcher) and the definition the thread screen hands to `<Screen workspace>`.
 */
export { threadWorkspace } from "./thread-workspace.ts";
/** Other slices' views the workspace tabs draw with (agent transcripts). */
export { ThreadPartsProvider, useThreadParts, type ThreadParts } from "./agents/thread-parts.ts";
/** A thread's agent work, and the subagent view's Stop. */
export { useTreeWork } from "./agents/use-tree-work.ts";
export { StopAgent } from "./agents/stop-agent.tsx";
export { useAgentIdentity } from "./agents/agent-identity.ts";
export { countSubagents, findAgentNode } from "./agents/subagents.ts";
export { disposePanelServices, findRunningTerminal, useRunningTerminalNames } from "./services.ts";
export {
  newTerminal,
  openNewTerminal,
  shellLabel,
  shellTab,
  terminalTab,
} from "./terminal/tabs.ts";
export { useAgentShells, useBackgroundShells } from "./terminal/use-terminals.ts";
/** A checkout file's tab, for whatever opens a file from outside the Files tool. */
export { fileTab } from "./files/tab-id.ts";
export { PullRequestViewProvider } from "./pull-request-view.tsx";
export { useScriptConfigurations } from "./files/script-configurations.ts";
/**
 * Views that load on first use: the new-file dialog, the sign-in terminal, the thread browser,
 * floating browsers and diff rendering. Keep this file re-exports only (see `loaders.ts`).
 */
export {
  loadCreateFile,
  loadAuthTerminal,
  loadThreadBrowser,
  loadFloatingBrowsers,
  DeferredFileDiffBlock,
  DeferredFileTree,
} from "./loaders.ts";
/**
 * Bring one of the thread's browser tabs to the person (a help request's Open tab), or the
 * Browser the daemon shows them (an agent's page, from its transcript row).
 */
export { useRevealBrowserTab, useShowBrowserPanel } from "./browser/reveal-tab.ts";
/** The thread's browser tabs the composer's `@` list offers. */
export { useMentionTabs, type MentionTab } from "./browser/mention-tabs.ts";

export { freshView, fileHeight, type FileView } from "./changes/file-view.ts";
export { useFileViews } from "./changes/file-views.ts";
export type { LineRange, LineTarget } from "./changes/file-diff.tsx";
export { bindTerminalEndDelivery } from "./terminal/end-delivery.ts";
export { useAlwaysShowDevices } from "./browser/device-settings.ts";
export { useAutomaticPip } from "./browser/pip-setting.ts";
export { useRevealAgentPages } from "./browser/reveal-setting.ts";
