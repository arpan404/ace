import type { aceAccountClient } from "@ace/client/ace-account";
import { AceAccountError } from "@ace/client/ace-account-error";
import { AceAccountGrant, type AceLogin } from "@ace/protocol/ace-account";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { accountSessionKey } from "@/boot/account-config.ts";
import { browserSignIn } from "./sign-in.ts";

export type AceAccountClient = ReturnType<typeof aceAccountClient>;

/**
 * Why a sign-in lasts only while the app is open: the app couldn't save it. With no keyring
 * (Linux without GNOME Keyring or KWallet), the app refuses to keep it in plain text.
 */
function unsavedSession(cause: unknown): string {
  const noKeyring = cause instanceof Error && cause.message.includes("storage is unavailable");
  return noKeyring
    ? "Signed in until ace closes: this computer has no keyring to save it in. Install GNOME Keyring or KWallet to stay signed in."
    : "Signed in until ace closes: ace couldn't save your sign-in on this computer.";
}

/** Where this window's ace session lives: the backend, the window's copy and the saved copy. */
export interface AceAccountBackend {
  origin: string;
  client: AceAccountClient;
  /** This window's copy (session storage), so a reload doesn't ask the backend first. */
  storage: KeyValueStorage;
  /** Where the browser goes when sign-in ends (`signInReturnTo`); absent keeps it there. */
  returnTo?: string | undefined;
  /** The desktop app's encrypted copy; absent in a browser. */
  secure?:
    | {
        read(origin: string): Promise<string | null>;
        write(origin: string, token: string | null): Promise<void>;
      }
    | undefined;
}

export interface AceAccountState {
  session: AceAccountGrant | null;
  /** A saved session is being checked with the backend. */
  restoring: boolean;
  error: string;
  /**
   * A browser sign-in in progress: its login once the backend has started it, and whether the
   * browser refused to open so the person must open it themselves.
   */
  signIn: { login: AceLogin | undefined; openBlocked: boolean } | null;
}

/**
 * This window's ace session, shared by Settings › Profile, the machine lists and the machine
 * pages: restored once from the window's or the app's saved copy, cleared when the backend says
 * it has ended (401), and written back on sign-in and sign-out. A browser sign-in belongs to the
 * window, not to a page, so leaving Settings while the browser is open doesn't cancel it.
 */
export function aceAccountStore(backend: AceAccountBackend) {
  const { origin, client, storage, secure } = backend;
  const key = accountSessionKey(origin);
  const stored = readJson(storage, key, AceAccountGrant.nullable(), null);
  let state: AceAccountState = { session: stored, restoring: true, error: "", signIn: null };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AceAccountState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const forget = async () => {
    storage.removeItem?.(key);
    update({ session: null });
    if (secure) await secure.write(origin, null);
  };
  /** The check under way or done, and the signal it runs under. */
  let restoring: { signal: AbortSignal; done: Promise<void> } | undefined;
  let signingIn: AbortController | undefined;
  const signedIn = async (session: AceAccountGrant): Promise<void> => {
    writeJson(storage, key, session);
    update({ session, error: "" });
    if (secure)
      await secure
        .write(origin, session.token)
        .catch((cause: unknown) => update({ error: unsavedSession(cause) }));
  };

  return {
    origin,
    client,
    returnTo: backend.returnTo,
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * Checks the saved session with the backend once; later calls share that check. A check
     * whose caller went away (its signal aborted, as a remount does) gives way to the next
     * caller's, so `restoring` always ends.
     */
    restore(signal: AbortSignal): Promise<void> {
      if (restoring && !restoring.signal.aborted) return restoring.done;
      const done = (async () => {
        const token = stored?.token ?? (await secure?.read(origin).catch(() => null));
        if (!token) return;
        const value = await client.session(
          token,
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        );
        const next = { ...value, token };
        writeJson(storage, key, next);
        update({ session: next, error: "" });
      })()
        .catch(async (cause: unknown) => {
          if (cause instanceof AceAccountError && cause.status === 401)
            await forget().catch(() => {});
          // An abort (the window closing) isn't the backend's failure; a later restore retries.
          if (signal.aborted) return;
          update({ error: "Couldn't verify your account. Try again." });
        })
        .finally(() => {
          if (!signal.aborted) update({ restoring: false });
        });
      restoring = { signal, done };
      return done;
    },
    /** A sign-in finished: keep the session for this window and, in the app, saved. */
    signedIn,
    /**
     * Ends the session at the backend and here. A session the backend already ended (401) is
     * signed out all the same; any other failure keeps it so the person can try again.
     */
    async signOut(): Promise<void> {
      const session = state.session;
      if (!session) return;
      update({ error: "" });
      try {
        await client.logout(session.token, AbortSignal.timeout(15_000));
      } catch (cause) {
        if (!(cause instanceof AceAccountError && cause.status === 401)) {
          update({ error: "Couldn't sign out. Reconnect and try again." });
          return;
        }
      }
      await forget().catch(() =>
        update({ error: "Signed out. Couldn't clear the saved account session." }),
      );
    },
    /** The backend refused the session on another call: it ended elsewhere. */
    async ended(): Promise<void> {
      await forget().catch(() => {});
      update({ error: "Your ace session ended. Sign in again." });
    },
    report(error: string) {
      update({ error });
    },
    /**
     * Starts a browser sign-in unless one is running. `open` takes the browser to the link; it
     * is called during this call, so a tab can be reserved in the click that started it.
     */
    signIn(open: (address: Promise<string>) => Promise<void>): void {
      if (signingIn || state.session) return;
      const controller = new AbortController();
      signingIn = controller;
      update({ error: "", signIn: { login: undefined, openBlocked: false } });
      const progress = (patch: Partial<NonNullable<AceAccountState["signIn"]>>) => {
        if (signingIn === controller && state.signIn)
          update({ signIn: { ...state.signIn, ...patch } });
      };
      void browserSignIn({
        client,
        returnTo: backend.returnTo,
        signal: controller.signal,
        open: (address) =>
          void open(address).catch(() => {
            if (!controller.signal.aborted) progress({ openBlocked: true });
          }),
        started: (login) => progress({ login }),
        interrupted: () => update({ error: "Connection interrupted. Retrying sign-in…" }),
      }).then(async (outcome) => {
        if (signingIn !== controller) return;
        signingIn = undefined;
        update({ signIn: null, error: outcome.kind === "failed" ? outcome.error : "" });
        if (outcome.kind === "signed-in") await signedIn(outcome.session);
      });
    },
    /** Stops the sign-in in progress; its link stops working. */
    cancelSignIn(): void {
      if (!signingIn) return;
      signingIn.abort();
      signingIn = undefined;
      update({ signIn: null, error: "" });
    },
  };
}
export type AceAccountStore = ReturnType<typeof aceAccountStore>;
