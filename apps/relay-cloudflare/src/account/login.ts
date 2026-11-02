import { AceAccountGrant } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";
import { digest, opaqueToken, pkce, sameDigest } from "./crypto.ts";
import type { RandomBytes } from "./crypto.ts";
import type { LoginStore } from "./logins.ts";
import { bearer, cookie, fail, json, page } from "./respond.ts";
import type { SessionStore } from "./sessions.ts";
import type { AccountProvider } from "./workos.ts";

export const LOGIN_LIFETIME_MS = 10 * 60_000;
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** Pending sign-ins across the whole service; beyond this, new ones are refused as busy. */
const MAX_PENDING_LOGINS = 1024;

const expired = () => page(410, "This sign-in has expired. Start again in ace.");
const unverified = () => page(400, "Sign-in could not be verified. Start again in ace.");

/**
 * The sign-in flow (ADR 0100): an app starts a login and keeps its private claim ticket, the
 * person's browser opens the login link and goes to WorkOS with PKCE, the callback must come
 * back to the same browser (an HttpOnly cookie), and the app claims the session with its ticket.
 */
export function loginRoutes(deps: {
  config: AccountConfig;
  logins: LoginStore;
  sessions: SessionStore;
  provider: Pick<AccountProvider, "authorizeUrl" | "exchange">;
  now: () => number;
  random: RandomBytes;
}) {
  const { config, logins, sessions, provider, now, random } = deps;
  const secure = config.publicUrl.startsWith("https:") ? "; Secure" : "";
  const bindingCookie = (id: string, value: string, maxAge: number) =>
    `ace_login_${id}=${value}; HttpOnly; SameSite=Lax; Path=/v1/account/callback; Max-Age=${maxAge}${secure}`;

  return {
    /** POST /v1/account/login */
    async start(): Promise<Response> {
      const time = now();
      await logins.sweep(time);
      if ((await logins.count(time)) >= MAX_PENDING_LOGINS) return fail(429, "busy");
      const id = opaqueToken(random);
      const secret = opaqueToken(random);
      const expiresAt = time + LOGIN_LIFETIME_MS;
      await logins.create(await digest(id), await digest(secret), expiresAt);
      return json(201, {
        id,
        secret,
        expiresAt,
        loginUrl: `${config.publicUrl}/v1/account/login?id=${id}`,
      });
    },

    /** GET /v1/account/login?id= — the person's browser, once. */
    async open(url: URL): Promise<Response> {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return expired();
      const auth = await pkce(random);
      const binding = opaqueToken(random);
      const opened = await logins.openBrowser(
        await digest(id),
        {
          state: await digest(auth.state),
          binding: await digest(binding),
          verifier: auth.verifier,
        },
        now(),
      );
      if (!opened) return expired();
      return new Response(null, {
        status: 302,
        headers: {
          Location: provider.authorizeUrl(auth.challenge, auth.state),
          "Set-Cookie": bindingCookie(id, binding, LOGIN_LIFETIME_MS / 1000),
        },
      });
    },

    /** GET /v1/account/callback — WorkOS sends the browser back here. */
    async callback(request: Request, url: URL): Promise<Response> {
      const state = url.searchParams.get("state");
      if (!state || state.length > 256) return unverified();
      const row = await logins.byState(await digest(state), now());
      if (!row?.binding) return unverified();
      // The cookie is named by the public login id; the row only knows the id's digest.
      const presented = [
        ...(request.headers.get("Cookie") ?? "").matchAll(/ace_login_([A-Za-z0-9_-]{43})=/g),
      ];
      let id: string | undefined;
      for (const match of presented)
        if (match[1] && sameDigest(await digest(match[1]), row.id)) id = match[1];
      const value = id ? cookie(request, `ace_login_${id}`) : undefined;
      if (!id || !value || !sameDigest(await digest(value), row.binding)) return unverified();
      const verifier = await logins.openVerifier(row);
      if (!verifier || !(await logins.startExchange(row.id, now()))) return unverified();
      // The binding is spent: clear the cookie whatever happens next.
      const withCookie = (response: Response) => {
        response.headers.set("Set-Cookie", bindingCookie(id, "", 0));
        return response;
      };
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        await logins.fail(row.id);
        return withCookie(page(400, "Sign-in was cancelled. You can keep using ace locally."));
      }
      let identity;
      try {
        identity = await provider.exchange(code, verifier);
      } catch {
        await logins.fail(row.id);
        return withCookie(page(502, "Sign-in could not finish. Start again in ace."));
      }
      const token = opaqueToken(random);
      const hash = await digest(token);
      const expiresAt = now() + SESSION_LIFETIME_MS;
      await sessions.put(hash, identity.account, identity.refreshToken, expiresAt);
      const grant = AceAccountGrant.parse({ token, expiresAt, account: identity.account });
      // A cancellation or expiry while WorkOS answered wins: the new session is discarded.
      if (!(await logins.complete(row.id, hash, grant, now()))) {
        await sessions.remove(hash);
        return withCookie(expired());
      }
      return withCookie(page(200, "You're signed in. Return to ace. You can close this tab."));
    },

    /** GET (claim) and DELETE (cancel) /v1/account/login/:id with the claim ticket. */
    async claim(request: Request, id: string): Promise<Response> {
      const hash = await digest(id);
      const row = await logins.get(hash, now());
      const secret = bearer(request);
      if (!row || !secret || !sameDigest(await digest(secret), row.secret))
        return fail(401, "invalid_login");
      if (request.method === "DELETE") {
        await logins.remove(hash);
        return json(200, { ok: true });
      }
      if (row.phase === "failed") return fail(410, "login_failed");
      if (row.phase !== "complete" || !row.session) return json(200, { status: "pending" });
      // A signed-out session cannot be claimed again by retrying.
      if (!(await sessions.get(row.session, now()))) {
        await logins.remove(hash);
        return fail(401, "invalid_login");
      }
      const grant = await logins.issued(row);
      if (!grant) return fail(401, "invalid_login");
      await logins.claimed(hash);
      return json(200, { status: "complete", session: grant });
    },
  };
}
