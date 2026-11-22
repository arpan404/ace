import { randomBytes } from "node:crypto";
import { appSocketTag } from "@ace/account-grant/app-channel";
import { APP_SOCKET_HEADER } from "@ace/protocol";

/*
 * Tags the app's own WebSocket upgrades to the daemon on this computer (ADR 0190, amendment 1):
 * a fresh random tag in a header main adds in the network stack, which no page can read or set.
 * Main proves for the tags it made, so a statement it signs can only ever reach the app's own
 * sockets, never one a page names or a process holding the daemon's token opened. Only the app's
 * own transport is tagged: an upgrade to exactly the daemon's address, from a page at the app's
 * own origin, in the app's default session (the agents' browser and visualizations run in other
 * partitions). A tag carries when it was made; the daemon takes it only while fresh.
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
  /** The app's own pages' origin (`app-protocol.ts`): no other page's socket is tagged. */
  appOrigin(): string | undefined;
  /** Whether this run keeps a device key at all: without one, nothing is tagged. */
  enabled(): boolean;
  tag?: () => string;
}) {
  const tag = options.tag ?? (() => appSocketTag(Date.now(), randomBytes(32)));
  const recent: string[] = [];
  /** The upgrade goes to exactly the daemon's transport address. */
  const toDaemon = (url: string) => {
    const daemon = options.daemonUrl();
    if (!daemon) return false;
    try {
      const to = new URL(url);
      const expected = new URL(daemon);
      return to.origin === expected.origin && to.pathname === expected.pathname && !to.search;
    } catch {
      return false;
    }
  };
  /** The upgrade comes from a page at the app's own origin. */
  const fromApp = (headers: Record<string, string>) => {
    const origin = options.appOrigin();
    const sent = Object.entries(headers).find(([name]) => name.toLowerCase() === "origin")?.[1];
    return origin !== undefined && sent === origin;
  };
  options.hook.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1/*", "ws://localhost/*", "ws://[::1]/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      // A page can't set this header on a WebSocket; whatever arrives is replaced.
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === APP_SOCKET_HEADER) delete headers[name];
      if (
        details.resourceType === "webSocket" &&
        toDaemon(details.url) &&
        fromApp(details.requestHeaders) &&
        options.enabled()
      ) {
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
