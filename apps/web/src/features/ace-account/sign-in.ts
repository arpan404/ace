import { AceAccountError } from "@ace/client/ace-account";
import type { AceAccountGrant, AceLogin } from "@ace/protocol/ace-account";
import type { AceAccountClient } from "./session-store.ts";

/** How the backend lets a sign-in wait for its browser (ADR 0100). */
const SIGN_IN_LIFETIME_MS = 10 * 60_000;
const CHECK_EVERY_MS = 2000;
const tooLong = "Sign-in took too long. Try again.";

export type SignInOutcome =
  | { kind: "signed-in"; session: AceAccountGrant }
  | { kind: "stopped" }
  | { kind: "failed"; error: string };

function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * One browser sign-in: starts it at the backend, has `open` take the browser to its link, and
 * checks until the browser finishes. `open` is called before the first await, so a browser tab
 * can be reserved during the click. Stopping it (`signal`) cancels it at the backend, so its
 * link stops working.
 */
export async function browserSignIn(options: {
  client: AceAccountClient;
  returnTo: string | undefined;
  signal: AbortSignal;
  open: (address: Promise<string>) => void;
  started: (login: AceLogin) => void;
  interrupted: () => void;
}): Promise<SignInOutcome> {
  const { client, signal: stop } = options;
  const signal = AbortSignal.any([stop, AbortSignal.timeout(SIGN_IN_LIFETIME_MS)]);
  let pending: AceLogin | undefined;
  const halted = (): SignInOutcome =>
    stop.aborted ? { kind: "stopped" } : { kind: "failed", error: tooLong };
  try {
    const request = client.login(
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      options.returnTo ? { returnTo: options.returnTo } : {},
    );
    options.open(request.then((login) => login.loginUrl));
    pending = await request;
    if (signal.aborted) return halted();
    options.started(pending);
    for (;;) {
      await pause(signal, CHECK_EVERY_MS);
      if (signal.aborted) return halted();
      const result = await client
        .poll(pending, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
        .catch((cause: unknown) => {
          if (cause instanceof AceAccountError && [401, 410].includes(cause.status)) throw cause;
          if (!signal.aborted) options.interrupted();
          return undefined;
        });
      if (signal.aborted) return halted();
      if (result?.status !== "complete") continue;
      pending = undefined;
      return { kind: "signed-in", session: result.session };
    }
  } catch (cause) {
    if (signal.aborted) return halted();
    // The backend forgets a sign-in after ten minutes (410).
    if (cause instanceof AceAccountError && cause.status === 410) {
      pending = undefined;
      return { kind: "failed", error: tooLong };
    }
    return { kind: "failed", error: "Couldn't sign in. Try again." };
  } finally {
    if (pending) void client.cancel(pending, AbortSignal.timeout(5000)).catch(() => {});
  }
}
