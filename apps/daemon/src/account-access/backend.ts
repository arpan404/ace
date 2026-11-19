import { GrantKeySet } from "@ace/account-grant";

/** Why the account backend did not answer: 401 means the session is gone. */
export class AccountBackendError extends Error {
  override name = "AccountBackendError";
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const responseLimit = 64 * 1024;

/**
 * The account backend's published grant keys (ADR 0111). Everything else (sign-in, grants) goes
 * through `@ace/client/ace-account`, which leaves keys out to keep Ed25519 from web bundles.
 */
export function accountBackend(options: { fetch: typeof fetch }) {
  async function call(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await options.fetch(url, {
        ...init,
        signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
    } catch (error) {
      throw new AccountBackendError(0, "Couldn't reach your ace account.", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccountBackendError(
        response.status,
        response.status === 401
          ? "Sign in to ace on this machine again."
          : "Couldn't reach your ace account.",
      );
    }
    const text = await response.text();
    if (text.length > responseLimit) throw new AccountBackendError(0, "Account response too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new AccountBackendError(0, "Invalid account response");
    }
  }
  return {
    async keys(origin: string, signal: AbortSignal): Promise<GrantKeySet> {
      return GrantKeySet.parse(await call(`${origin}/v1/keys`, { method: "GET" }, signal));
    },
  };
}
