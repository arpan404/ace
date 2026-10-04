import type { ConnectionState } from "@ace/client";

/** The daemon connection in a word, for the sidebar's foot and its account menu. */
export const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  fatal: "Disconnected",
};
