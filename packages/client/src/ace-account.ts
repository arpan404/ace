import {
  AceAccountOrigin,
  AceAccountSession,
  AceGrantRequest,
  AceGrantResponse,
  AceLogin,
  AceLoginRequest,
  AceLoginStatus,
  AceMachine,
  AceMachineList,
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
    body?: unknown,
  ) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Built apart from the call: Workers typings (the relay's tests) lack `credentials`.
    const init = {
      method,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    } as const;
    const response = await options.fetch(`${origin}/v1/${path}`, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AceAccountError(response.status);
    }
    return httpJson(response, 64 * 1024);
  }
  return {
    /**
     * Starts a sign-in. `returnTo` is where the browser goes when it ends (the apps'
     * `ace://account/signed-in`, or the web app's landing page); without it the browser stays on
     * the backend's own page.
     */
    async login(signal: AbortSignal, request: AceLoginRequest = {}) {
      const body = AceLoginRequest.parse(request);
      const login = AceLogin.parse(
        await call(
          "account/login",
          "POST",
          undefined,
          signal,
          body.returnTo === undefined ? undefined : body,
        ),
      );
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
      return AceLoginStatus.parse(
        await call(`account/login/${login.id}`, "GET", login.secret, signal),
      );
    },
    async cancel(login: AceLogin, signal: AbortSignal) {
      await call(`account/login/${login.id}`, "DELETE", login.secret, signal);
    },
    async session(token: string, signal: AbortSignal) {
      return AceAccountSession.parse(await call("account/session", "GET", token, signal));
    },
    async logout(token: string, signal: AbortSignal) {
      await call("account/session", "DELETE", token, signal);
    },
    /** A five-minute grant for the hosted relay: `machine` for a daemon, `device` for a client. */
    async grant(token: string, request: AceGrantRequest, signal: AbortSignal) {
      return AceGrantResponse.parse(
        await call("grants", "POST", token, signal, AceGrantRequest.parse(request)),
      );
    },
    /** Machines signed in to this account, most recently seen first. */
    async machines(token: string, signal: AbortSignal): Promise<AceMachine[]> {
      return AceMachineList.parse(await call("machines", "GET", token, signal)).machines;
    },
    /** Removes a machine from this account's list. It returns if it signs in again. */
    async forgetMachine(token: string, hostId: string, signal: AbortSignal) {
      await call(`machines/${AceMachine.shape.hostId.parse(hostId)}`, "DELETE", token, signal);
    },
  };
}
