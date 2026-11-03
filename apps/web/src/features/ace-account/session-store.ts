import { AceAccountError, type aceAccountClient } from "@ace/client/ace-account";
import { AceAccountGrant } from "@ace/protocol/ace-account";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { accountSessionKey } from "@/boot/account-config.ts";

export type AceAccountClient = ReturnType<typeof aceAccountClient>;

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
}

/**
 * This window's ace session, shared by Settings › Profile, the machine lists and the machine
 * pages: restored once from the window's or the app's saved copy, cleared when the backend says
 * it has ended (401), and written back on sign-in and sign-out.
 */
export function aceAccountStore(backend: AceAccountBackend) {
  const { origin, client, storage, secure } = backend;
  const key = accountSessionKey(origin);
  const stored = readJson(storage, key, AceAccountGrant.nullable(), null);
  let state: AceAccountState = { session: stored, restoring: true, error: "" };
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
  let restoring: Promise<void> | undefined;

  return {
    origin,
    client,
    returnTo: backend.returnTo,
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Checks the saved session with the backend once; later calls share that check. */
    restore(signal: AbortSignal): Promise<void> {
      restoring ??= (async () => {
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
          if (signal.aborted) {
            restoring = undefined;
            return;
          }
          update({ error: "Couldn't verify your account. Try again." });
        })
        .finally(() => {
          if (!signal.aborted) update({ restoring: false });
        });
      return restoring;
    },
    /** A sign-in finished: keep the session for this window and, in the app, saved. */
    async signedIn(session: AceAccountGrant): Promise<void> {
      writeJson(storage, key, session);
      update({ session, error: "" });
      if (secure)
        await secure
          .write(origin, session.token)
          .catch(() => update({ error: "Signed in for this window only." }));
    },
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
  };
}
export type AceAccountStore = ReturnType<typeof aceAccountStore>;
