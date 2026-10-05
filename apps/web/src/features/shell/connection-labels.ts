import type { ConnectionState } from "@ace/client";

/** The daemon connection in a word, for the account button's name and the daemon menu. */
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
};

/**
 * The connection's dot: filled green when connected, a hollow ring while trying (pulsing;
 * reduced motion stops every animation) or offline, filled red once it has given up.
 */
export const connectionDot: Record<ConnectionState, string> = {
  ready: "bg-status-done",
  connecting: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] animate-pulse",
  reconnecting: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)] animate-pulse",
  offline: "shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)]",
  fatal: "bg-status-failed",
};
