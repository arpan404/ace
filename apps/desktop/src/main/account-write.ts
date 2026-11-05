import type { MachineAccountStatus } from "@ace/protocol";
import type { DaemonConnection } from "../shared/contract.ts";
import { handAccountToDaemon, readDaemonAccount } from "./account-handover.ts";

/*
 * What the app's own sign-in and sign-out do to this computer's daemon (ADR 0111). The app
 * shares its session only with a daemon that has none, or whose session (live or lapsed) the
 * app gave it on this same account. A daemon signed in on its own (`ace login`), even one whose
 * session lapsed, is never moved or signed out by the app; Settings' Switch is the one way to
 * move it. A daemon that can't make the change conditional on what was read (no `sessionId`)
 * is never changed at all.
 */

/**
 * Whether the app, signed in to `app.accountId` at `app.origin`, hands its session to the
 * daemon: yes when the daemon holds no session at all, or the app gave it the one it holds on
 * this same account. Never while a sign-in from the machine is under way.
 */
export function handsOverOnSignIn(
  daemon: MachineAccountStatus,
  app: { origin: string; accountId: string | undefined },
): boolean {
  if (daemon.sessionId === undefined || daemon.login) return false;
  if (daemon.account === undefined) return !daemon.signedIn;
  return (
    daemon.source === "handover" &&
    daemon.origin === app.origin &&
    daemon.account.id === app.accountId
  );
}

/**
 * Whether the app, signed out at `origin`, signs the daemon out too: only when the daemon's
 * session came from the app for that origin.
 */
export function signsOutOnSignOut(daemon: MachineAccountStatus, origin: string): boolean {
  return (
    typeof daemon.sessionId === "string" && daemon.source === "handover" && daemon.origin === origin
  );
}

export interface AppAccountDeps {
  /** The app's saved ace sessions by origin, read fresh each time. */
  saved(): Promise<Readonly<Record<string, string>>>;
  /** The account id an app session belongs to, from the account backend. */
  accountOf(origin: string, token: string): Promise<string>;
  send?: typeof fetch;
}

/**
 * Brings this computer's daemon in line with the app's saved session for `origin` (signed in,
 * or signed out), as the rules above allow. Resolves with what it did. The app's session is
 * read when this runs and again just before the change, and the change applies only while the
 * daemon still holds the session it was read with, so neither a newer app sign-in or sign-out
 * nor the machine's own sign-in is ever overwritten. A remote daemon, or one without ace
 * accounts, is never touched.
 */
export async function followAppAccount(
  connection: DaemonConnection,
  origin: string,
  deps: AppAccountDeps,
): Promise<"handedOver" | "signedOut" | "left"> {
  const send = deps.send ?? fetch;
  const tokenNow = async () => (await deps.saved())[origin] ?? null;
  const token = await tokenNow();
  const daemon = await readDaemonAccount(connection, send);
  if (!daemon) return "left";
  if (token === null) {
    if (!signsOutOnSignOut(daemon, origin) || (await tokenNow()) !== null) return "left";
    const done = await handAccountToDaemon(connection, origin, null, send, daemon.sessionId);
    return done ? "signedOut" : "left";
  }
  // Only a daemon that names an account needs the app's account to compare with.
  const accountId = daemon.account
    ? await deps.accountOf(origin, token).catch(() => undefined)
    : undefined;
  if (!handsOverOnSignIn(daemon, { origin, accountId })) return "left";
  // The app signed out or in again meanwhile: the work queued for that change decides.
  if ((await tokenNow()) !== token) return "left";
  const done = await handAccountToDaemon(connection, origin, token, send, daemon.sessionId);
  return done ? "handedOver" : "left";
}
