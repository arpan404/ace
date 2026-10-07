import { loginUrl, type cursorSdkLoginDriver, type ProviderLoginDriver } from "@ace/accounts";
import { createCursorLoginDriver } from "@ace/adapter-cursor/auth";
import type { ProviderInstance } from "@ace/protocol/accounts";

/** The adapter stream owns SDK cancellation and drains its isolated host before completion. */
export function cursorLoginDriver(
  instance: ProviderInstance,
  account: Pick<ReturnType<typeof cursorSdkLoginDriver>, "login" | "logout">,
  action: "login" | "logout",
): ProviderLoginDriver {
  return {
    async run(signal, emit) {
      if (action === "logout") {
        await account.logout(instance, signal);
        signal.throwIfAborted();
        return { success: true };
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
