import {
  loginUrl,
  ProviderLoginFailure,
  type LoginUpdate,
  type ProviderLoginDriver,
} from "@ace/accounts";
import type {
  CodexAccount,
  CodexLoginAttempt,
  CodexLoginKind,
} from "@ace/adapter-codex/account-login";

/**
 * Codex ChatGPT sign-in through its app-server. A device code comes first: it works from any
 * device. OpenAI only allows it once the person enables device codes in ChatGPT's security
 * settings, so when Codex refuses or fails it, the browser sign-in (a page whose callback is
 * this computer) follows. When the app-server can't sign in at all, Codex's own login runs in a
 * terminal as before.
 */
export function codexLoginDriver(options: {
  account(signal: AbortSignal): Promise<CodexAccount>;
  /** The terminal sign-in, for a Codex whose app-server can't start a ChatGPT login. */
  fallback: ProviderLoginDriver;
  /** The signed-in account's email, to label the account with. */
  onAccount?(label: string): void;
  assertCurrent?(): void;
}): ProviderLoginDriver {
  let fellBack = false;
  return {
    ...(options.fallback.manual ? { manual: options.fallback.manual } : {}),
    input: (input) => (fellBack ? (options.fallback.input?.(input) ?? false) : false),
    async drain() {
      await options.fallback.drain?.();
    },
    async run(signal, emit) {
      let account: CodexAccount | undefined;
      let attempt: CodexLoginAttempt | undefined;
      const start = async (kind: CodexLoginKind) => {
        try {
          const started = await account?.login(kind);
          const url = started && loginUrl("codex", started.url);
          if (started && url) return { ...started, url };
          if (started) await account?.cancel(started.loginId).catch(() => {});
        } catch {
          signal.throwIfAborted();
        }
        return undefined;
      };
      const finish = (started: CodexLoginAttempt) =>
        new Promise<{ success: boolean }>((resolve, reject) => {
          const abort = () => reject(new Error("Cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          void started.completed.then((result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
          });
        });
      try {
        // The server outlives a cancelled sign-in long enough to cancel it in Codex; only a
        // cancel during startup stops it at once.
        const lifetime = new AbortController();
        const stopOpening = () => lifetime.abort();
        signal.addEventListener("abort", stopOpening, { once: true });
        try {
          account = await options.account(lifetime.signal);
        } catch {
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", stopOpening);
        }
        signal.throwIfAborted();
        options.assertCurrent?.();
        attempt = await start("chatgptDeviceCode");
        if (attempt) {
          const update: LoginUpdate = {
            state: attempt.userCode ? "awaiting_code_entry" : "awaiting_browser",
            url: attempt.url,
          };
          if (attempt.userCode && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/.test(attempt.userCode))
            update.userCode = attempt.userCode;
          emit(update);
          const device = await finish(attempt);
          attempt = undefined;
          if (device.success) return await signedIn(account);
        }
        // Device codes off for this account (or none offered): the browser sign-in instead.
        attempt = await start("chatgpt");
        if (!attempt) {
          if (account) await account.close();
          account = undefined;
          fellBack = true;
          return await options.fallback.run(signal, emit);
        }
        emit({ state: "awaiting_browser", url: attempt.url });
        const browser = await finish(attempt);
        attempt = undefined;
        if (browser.success) return await signedIn(account);
        throw new ProviderLoginFailure("Codex couldn't finish signing in. Try again.");
      } finally {
        if (attempt) await account?.cancel(attempt.loginId).catch(() => {});
        await account?.close();
      }
    },
  };
  async function signedIn(account: CodexAccount | undefined) {
    options.assertCurrent?.();
    const read = await account?.read().catch(() => undefined);
    if (read?.email) options.onAccount?.(read.email);
    return { success: true };
  }
}
