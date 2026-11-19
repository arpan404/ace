import type { ConnectionState } from "@ace/client";

/** The daemon connection in a word, for the account button's name and the daemon menu. */
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  starting: "Starting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
};

/**
 * The connection's dot: filled green when connected, a ring half filled in while trying, a hollow
 * ring offline, filled red once it has given up. It holds still; its words say which.
 */
export const connectionDot: Record<ConnectionState, string> = {
  ready: "bg-status-done",
  starting: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] bg-subtle-foreground/40",
  connecting: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] bg-subtle-foreground/40",
  reconnecting: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] bg-subtle-foreground/40",
  offline: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)]",
  fatal: "bg-status-failed",
};
