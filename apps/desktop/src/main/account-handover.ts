import { MachineAccountStatus } from "@ace/protocol";
import { aceAccountClient } from "@ace/client/ace-account";
import type { DaemonConnection } from "../shared/contract.ts";

/**
 * A single-use enrollment ticket for the daemon on this computer (ADR 0190), got with the app's
 * own session and bound to the relay host id its home's key names. The daemon is given this,
 * never the session: whatever answers at the daemon's address can at most sign that machine in.
 */
export async function enrollmentFor(
  connection: DaemonConnection,
  origin: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<string> {
  if (connection.mode !== "daemon" || !connection.localRelayHostId)
    throw new Error("Update ace on this computer to sign it in from the app.");
  const backend = aceAccountClient({ origin, fetch: request });
  const enrollment = await backend.machineEnrollment(
    token,
    connection.localRelayHostId,
    AbortSignal.timeout(15_000),
  );
  return enrollment.ticket;
}

/**
 * Signs the daemon this app runs on this computer in to the app's ace account with an enrollment
 * ticket (ADR 0190), or signs out what the app signed it in with (ADR 0111). Whether to is decided
 * first (`account-write.ts`, `account-follow.ts`); this only sends it. A remote daemon is never
 * signed in from here, and no daemon is ever given the session.
 *
 * `expected` is the `sessionId` the decision was read with: the daemon then applies it only
 * while it still holds that session (null: none), and this resolves false when it no longer
 * does. Undefined sends it unconditionally.
 */
export async function handAccountToDaemon(
  connection: DaemonConnection,
  origin: string,
  token: string | null,
  request: typeof fetch = fetch,
  expected?: string | null,
): Promise<boolean> {
  if (connection.mode !== "daemon" || connection.localHostId === undefined) return false;
  const ticket = token ? await enrollmentFor(connection, origin, token, request) : undefined;
  const url = new URL("/v1/ace-account", connection.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const condition: Record<string, string> =
    expected === undefined
      ? {}
      : expected === null
        ? { "if-none-match": "*" }
        : { "if-match": `"${expected}"` };
  const response = await request(url, {
    method: ticket ? "PUT" : "DELETE",
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...condition,
      ...(ticket ? { "content-type": "application/json" } : {}),
    },
    ...(ticket ? { body: JSON.stringify({ origin, ticket }) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  // 412: the daemon's account changed since it was read; it keeps what it has.
  if (response.status === 412) return false;
  if (!response.ok) throw new Error(`The daemon did not take the ace session (${response.status})`);
  return true;
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
