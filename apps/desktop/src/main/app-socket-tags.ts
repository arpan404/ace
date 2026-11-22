import { randomBytes } from "node:crypto";
import { APP_SOCKET_HEADER } from "@ace/protocol";

/*
 * Tags the app's own WebSocket upgrades to the daemon on this computer (ADR 0190, amendment 1):
 * a fresh random tag in a header main adds in the network stack, which no page can read or set.
 * Main proves for the tags it made, so a statement it signs can only ever reach the app's own
 * sockets, never one a page names or a process holding the daemon's token opened. Only the app's
 * default session is tagged; the agents' browser and visualizations run in other partitions.
 */

/** How many recent tags main proves for: its windows' and worker's live sockets, with room. */
const KEPT = 32;

/** The slice of Electron's `webRequest` this uses; injected for tests. */
export interface UpgradeHook {
  onBeforeSendHeaders(
    filter: { urls: string[] },
    listener: (
      details: { url: string; resourceType: string; requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ): void;
}

export function appSocketTags(options: {
  hook: UpgradeHook;
  /** The daemon on this computer the app talks to, when there is one. */
  daemonUrl(): string | undefined;
  /** Whether this run keeps a device key at all: without one, nothing is tagged. */
  enabled(): boolean;
  tag?: () => string;
}) {
  const tag = options.tag ?? (() => randomBytes(32).toString("base64url"));
  const recent: string[] = [];
  const sameDaemon = (url: string) => {
    const daemon = options.daemonUrl();
    if (!daemon) return false;
    try {
      return new URL(url).host === new URL(daemon).host;
    } catch {
      return false;
    }
  };
  options.hook.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1/*", "ws://localhost/*", "ws://[::1]/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      // A page can't set this header on a WebSocket; whatever arrives is replaced.
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === APP_SOCKET_HEADER) delete headers[name];
      if (details.resourceType === "webSocket" && sameDaemon(details.url) && options.enabled()) {
        const next = tag();
        headers[APP_SOCKET_HEADER] = next;
        recent.push(next);
        if (recent.length > KEPT) recent.shift();
      }
      callback({ requestHeaders: headers });
    },
  );
  return {
    /** The tags main made lately, newest last: the app's own sockets among them. */
    recent: (): readonly string[] => [...recent],
  };
}
export type AppSocketTags = ReturnType<typeof appSocketTags>;
