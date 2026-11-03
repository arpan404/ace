import type { DaemonConnection } from "../shared/contract.ts";

/**
 * Hands the app's ace session to the daemon this app runs on this computer, or tells it the app
 * signed out (ADR 0111), so the machine joins the same account without its own sign-in. A remote
 * daemon is never given the session. Best effort: the app's own sign-in does not depend on it.
 */
export async function handAccountToDaemon(
  connection: DaemonConnection,
  origin: string,
  token: string | null,
  request: typeof fetch = fetch,
): Promise<void> {
  if (connection.mode !== "daemon" || connection.localHostId === undefined) return;
  const url = new URL("/v1/ace-account", connection.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const response = await request(url, {
    method: token ? "PUT" : "DELETE",
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(token ? { "content-type": "application/json" } : {}),
    },
    ...(token ? { body: JSON.stringify({ origin, token }) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The daemon did not take the ace session (${response.status})`);
}
