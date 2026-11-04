import type { MachineAccountStatus } from "@ace/protocol";
import type { DaemonConnection } from "../shared/contract.ts";
import { handAccountToDaemon, readDaemonAccount } from "./account-handover.ts";

/*
 * What the app's own sign-in and sign-out do to this computer's daemon (ADR 0111). The app
 * shares its session only with a daemon that has none, or that is already on the same account
 * through the app. A daemon signed in on its own (`ace login`) is never moved or signed out by
 * the app; Settings' Switch is the one way to move it.
 */

/**
 * Whether the app, just signed in to `app.accountId` at `app.origin`, hands its session to the
 * daemon. Yes when the daemon is signed out (unless its lapsed session names another account),
 * or when the app gave it its session on this same account before. Never when the daemon signed
 * in on its own, or to another account, or says nothing of where its session came from.
 */
export function handsOverOnSignIn(
  daemon: MachineAccountStatus,
  app: { origin: string; accountId: string | undefined },
): boolean {
  const sameAccount =
    daemon.origin === app.origin &&
    daemon.account !== undefined &&
    daemon.account.id === app.accountId;
  if (!daemon.signedIn) return daemon.account === undefined || sameAccount;
  return sameAccount && daemon.source === "handover";
}

/**
 * Whether the app, just signed out at `origin`, signs the daemon out too: only when the daemon's
 * session came from the app for that origin.
 */
export function signsOutOnSignOut(daemon: MachineAccountStatus, origin: string): boolean {
  return daemon.source === "handover" && daemon.origin === origin;
}

/**
 * Follows the app's sign-in (`token`) or sign-out (`null`) on this computer's daemon, as the
 * rules above allow. Resolves with what it did. A remote daemon, or one without ace accounts, is
 * never touched.
 */
export async function followAppAccount(
  connection: DaemonConnection,
  write: { origin: string; token: string | null },
  deps: {
    /** The account id an app session belongs to, from the account backend. */
    accountOf(origin: string, token: string): Promise<string>;
    send?: typeof fetch;
  },
): Promise<"handedOver" | "signedOut" | "left"> {
  const send = deps.send ?? fetch;
  const daemon = await readDaemonAccount(connection, send);
  if (!daemon) return "left";
  const { origin, token } = write;
  if (token === null) {
    if (!signsOutOnSignOut(daemon, origin)) return "left";
    await handAccountToDaemon(connection, origin, null, send);
    return "signedOut";
  }
  // Only a daemon that names an account needs the app's account to compare with.
  const accountId = daemon.account
    ? await deps.accountOf(origin, token).catch(() => undefined)
    : undefined;
  if (!handsOverOnSignIn(daemon, { origin, accountId })) return "left";
  await handAccountToDaemon(connection, origin, token, send);
  return "handedOver";
}
