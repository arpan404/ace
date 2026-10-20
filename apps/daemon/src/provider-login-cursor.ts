import {
  loginUrl,
  ProviderLoginFailure,
  type cursorSdkLoginDriver,
  type ProviderLoginDriver,
} from "@ace/accounts";
import { createCursorLoginDriver, CursorSdkUnavailableError } from "@ace/adapter-cursor/auth";
import type { ProviderInstance } from "@ace/protocol/accounts";

const environmentKeyRemains =
  "ace removed Cursor's saved sign-in, but CURSOR_API_KEY in the environment ace was started with still signs Cursor in. Remove it there to sign out completely.";

/** Cursor's SDK sign-out only forgets the key here; the key its sign-in minted lives on. */
const mintedKeyRemains =
  "Signed out of Cursor on this computer. The key Cursor made for ace stays valid until it expires; delete it under API keys in Cursor's dashboard to end it now.";

/** The adapter stream owns SDK cancellation and drains its isolated host before completion. */
export function cursorLoginDriver(
  instance: ProviderInstance,
  account: Pick<ReturnType<typeof cursorSdkLoginDriver>, "login" | "logout">,
  action: "login" | "logout",
): ProviderLoginDriver {
  return {
    async run(signal, emit) {
      if (action === "logout") {
        let auth: Awaited<ReturnType<typeof account.logout>>;
        try {
          auth = await account.logout(instance, signal);
        } catch (error) {
          signal.throwIfAborted();
          throw new ProviderLoginFailure(
            error instanceof CursorSdkUnavailableError
              ? "Cursor's SDK isn't available in this ace install, so ace can't change the Cursor sign-in."
              : "Cursor's SDK didn't finish signing out, so its saved sign-in may still be in place. Try again; the daemon log has the cause.",
          );
        }
        signal.throwIfAborted();
        return auth.source === "environment" && auth.status === "logged-in"
          ? { success: true, message: environmentKeyRemains }
          : { success: true, message: mintedKeyRemains };
      }
      const login = createCursorLoginDriver(
        { id: instance.id, homeDir: instance.homeDir },
        { login: (_identity, joined, url) => account.login(instance, joined, url) },
      );
      for await (const progress of login.start(signal)) {
        if (progress.state === "complete") return { success: true };
        if (progress.state === "failed" || progress.state === "cancelled")
          return { success: false };
        const url = progress.url ? loginUrl("cursor", progress.url) : undefined;
        if (progress.url && !url) throw new Error("Unrecognized SDK challenge");
        emit({
          state: url ? "awaiting_browser" : "starting",
          ...(url ? { url } : {}),
          ...(url ? { prompt: "Sign in to Cursor in your browser." } : {}),
        });
      }
      return { success: false };
    },
  };
}
