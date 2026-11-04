import { MachineAccountStatus } from "@ace/protocol";
import type { DaemonConnection } from "../shared/contract.ts";

/**
 * Hands the app's ace session to the daemon this app runs on this computer, or signs out the
 * session the app handed it (ADR 0111). Whether to is decided first (`account-write.ts`,
 * `account-follow.ts`); this only sends it. A remote daemon is never given the session.
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

/**
 * This computer's daemon's ace account status, or undefined for a remote daemon or one without
 * ace account support (404).
 */
export async function readDaemonAccount(
  connection: DaemonConnection,
  request: typeof fetch = fetch,
): Promise<MachineAccountStatus | undefined> {
  if (connection.mode !== "daemon" || connection.localHostId === undefined) return undefined;
  const url = new URL("/v1/ace-account", connection.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const response = await request(url, {
    headers: { authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return MachineAccountStatus.parse(await response.json());
}
