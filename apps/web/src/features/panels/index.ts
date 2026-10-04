/**
 * The thread's workspace: its tab kinds (Changes, Terminal, Preview, Devices, Agents, Logs, the
 * new-tab launcher) and the definition the thread screen hands to `<Screen workspace>`.
 */
export { threadWorkspace } from "./thread-workspace.ts";
/** Other slices' views the workspace tabs draw with (agent transcripts, deck lanes). */
export {
  deckLaneTab,
  ThreadPartsProvider,
  useThreadParts,
  type ThreadParts,
} from "./agents/thread-parts.ts";
export { findRunningTerminal } from "./services.ts";
export {
  newTerminal,
  openNewTerminal,
  shellLabel,
  shellTab,
  terminalTab,
} from "./terminal/tabs.ts";
export { useBackgroundShells } from "./terminal/use-terminals.ts";
