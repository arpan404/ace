import { desktopDaemon } from "./desktop.ts";

/**
 * While the desktop app starts its daemon, the page may already be open on what it cached, its
 * client reconnecting with a growing backoff. The moment the desktop says the daemon runs, that
 * waiting reconnect runs at once instead of after its backoff. A no-op in a browser, and for a
 * client that is connected or not waiting to reconnect. Returns a function that stops it.
 */
export function reconnectWhenDesktopDaemonRuns(
  client: { reconnectNow(): void },
  scope: object = globalThis,
): () => void {
  const daemon = desktopDaemon(scope);
  if (!daemon) return () => {};
  return daemon.onStatus((status) => {
    if (status.state === "running") client.reconnectNow();
  });
}
