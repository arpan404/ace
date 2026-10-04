/**
 * The thread's workspace: its tab kinds (Changes, Terminal, Preview, Devices, Agents, Logs, the
 * new-tab launcher) and the definition the thread screen hands to `<Screen workspace>`.
 */
export { threadKinds, threadWorkspace } from "./thread-workspace.tsx";
export { revealRunningTerminal, revealTerminal } from "./services.ts";
