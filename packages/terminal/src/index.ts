export { TerminalManager } from "./manager.ts";
export type { TerminalManagerOptions, TerminalDependencies } from "./manager.ts";
export { createPosixBackendFactory } from "./pty.ts";
export type { PtyBackend, BackendFactory, NativePty, PosixPorts } from "./pty.ts";
export type { ShutdownScheduler, ProcessControl } from "./ownership.ts";
export type { Terminal } from "./terminal.ts";
export type {
  OpenTerminalOptions,
  ExitStatus,
  TerminalEvent,
  TerminalAttachment,
  TerminalSnapshot,
} from "./types.ts";
