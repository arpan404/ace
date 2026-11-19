import type { SpadeConnectStart } from "@ace/ui-core/spade-chat";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { SpadeRequestError } from "./spade-requests.ts";

/**
 * Nothing to open: the server connected without a sign-in, or it is a device sign-in, whose code
 * the connector's row shows.
 */
class NothingToOpen extends Error {
  constructor() {
    super("nothing to open");
  }
}

/** How starting a connection ended, for the form that started it. */
export type ConnectOutcome =
  | { kind: "done" }
  /** The server needs a client ID registered with its maker (Spade answered 409). */
  | { kind: "needs_client"; message: string }
  /** The app signs in through Spade Cloud, and this machine isn't signed in to ace. */
  | { kind: "needs_ace_account"; message: string }
  | { kind: "failed"; message: string };

/**
 * Starts a connection and opens its sign-in in the person's own browser. A browser blocks a tab
 * opened after waiting, so the tab opens on the click and goes to the sign-in when Spade answers
 * (it closes again when there is nothing to sign in to).
 */
export async function connectInBrowser(
  start: () => Promise<SpadeConnectStart>,
): Promise<ConnectOutcome> {
  const address = start().then((started) => {
    if (started.kind !== "sign_in") throw new NothingToOpen();
    return started.url;
  });
  try {
    await openExternalWhenReady(address);
    return { kind: "done" };
  } catch (error) {
    return outcome(error);
  }
}

/** A connection made in one request (a token): nothing opens. */
export async function connectHere(
  start: () => Promise<SpadeConnectStart>,
): Promise<ConnectOutcome> {
  try {
    await start();
    return { kind: "done" };
  } catch (error) {
    return outcome(error);
  }
}

function outcome(error: unknown): ConnectOutcome {
  if (error instanceof NothingToOpen) return { kind: "done" };
  const message = error instanceof Error ? error.message : "Try again.";
  if (error instanceof SpadeRequestError && error.status === 409)
    return error.needs === "ace_account"
      ? { kind: "needs_ace_account", message }
      : { kind: "needs_client", message };
  return { kind: "failed", message };
}
