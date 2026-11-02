import {
  AceAccountOrigin,
  AceAccountSession,
  AceLogin,
  AceLoginStatus,
} from "@ace/protocol/ace-account";
import { httpJson } from "./http-json.ts";

export class AceAccountError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? "Sign in to ace again." : "Couldn't reach your ace account. Try again.");
    this.status = status;
  }
}

/** Calls the account backend, never a paired daemon or a coding provider. */
export function aceAccountClient(options: { origin: string; fetch: typeof fetch }) {
  const origin = AceAccountOrigin.parse(options.origin);
  async function call(
    path: string,
    method: string,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    const response = await options.fetch(`${origin}/v1/account/${path}`, {
      method,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AceAccountError(response.status);
    }
    return httpJson(response, 64 * 1024);
  }
  return {
    async login(signal: AbortSignal) {
      const login = AceLogin.parse(await call("login", "POST", undefined, signal));
      const url = new URL(login.loginUrl);
      if (
        url.origin !== origin ||
        url.pathname !== "/v1/account/login" ||
        url.searchParams.get("id") !== login.id
      )
        throw new Error("Invalid ace sign-in address");
      return login;
    },
    async poll(login: AceLogin, signal: AbortSignal) {
      return AceLoginStatus.parse(await call(`login/${login.id}`, "GET", login.secret, signal));
    },
    async cancel(login: AceLogin, signal: AbortSignal) {
      await call(`login/${login.id}`, "DELETE", login.secret, signal);
    },
    async session(token: string, signal: AbortSignal) {
      return AceAccountSession.parse(await call("session", "GET", token, signal));
    },
    async logout(token: string, signal: AbortSignal) {
      await call("session", "DELETE", token, signal);
    },
  };
}
