import { AceAccountGrant, AceLoginRequest } from "@ace/protocol/ace-account";
import type { AceSignInReturnStatus } from "@ace/protocol/ace-account";
import type { AccountConfig } from "./config.ts";
import { digest, opaqueToken, pkce, sameDigest } from "./crypto.ts";
import type { RandomBytes } from "./crypto.ts";
import type { LoginRow, LoginStore } from "./logins.ts";
import { continuePage, page } from "./pages.ts";
import { bearer, cookie, fail, json } from "./respond.ts";
import { allowedReturnTo, returnAddress } from "./return-to.ts";
import type { SessionStore } from "./sessions.ts";
import type { AccountProvider } from "./workos.ts";

/** Sends the browser to the sign-in's return address with `status`, or shows `shown`. */
function ended(row: LoginRow, status: AceSignInReturnStatus, shown: Response): Response {
  if (!row.return_to) return shown;
  return new Response(null, {
    status: 302,
    headers: { Location: returnAddress(row.return_to, status) },
  });
}

export const LOGIN_LIFETIME_MS = 10 * 60_000;
/** How long a session lasts unused: each read renews it for this long (`session.ts`). */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
/** Pending sign-ins across the whole service; beyond this, new ones are refused as busy. */
const MAX_PENDING_LOGINS = 1024;

const expired = () =>
  page(410, "This sign-in has expired or was already used. Start again in ace.");
const unverified = () => page(400, "Sign-in could not be verified. Start again in ace.");
const loginId = /^[A-Za-z0-9_-]{43}$/;

/** The optional `POST /v1/account/login` body: undefined when it is not a valid request. */
async function loginRequest(request: Request): Promise<AceLoginRequest | undefined> {
  if (Number(request.headers.get("Content-Length") ?? "0") > 4096) return undefined;
  const text = await request.text();
  if (text.length > 4096) return undefined;
  if (text.trim() === "") return {};
  try {
    const parsed = AceLoginRequest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One field of a small form post, if present and matching `pattern`. */
async function formField(
  request: Request,
  name: string,
  pattern: RegExp,
): Promise<string | undefined> {
  if (Number(request.headers.get("Content-Length") ?? "0") > 1024) return undefined;
  const text = await request.text();
  if (text.length > 1024) return undefined;
  const value = new URLSearchParams(text).get(name) ?? "";
  return pattern.test(value) ? value : undefined;
}
/** The login id a continue form posts, if well formed. */
const formId = (request: Request) => formField(request, "id", loginId);
/** A WorkOS invitation token, as the join page's form posts it. */
export const invitationToken = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The sign-in flow (ADR 0100): an app starts a login and keeps its private claim ticket, the
 * person's browser opens the login link and continues from it to WorkOS with PKCE, the callback
 * must come back to the same browser (an HttpOnly cookie), and the app claims the session with
 * its ticket. A sign-in started with a return address sends the browser there at the end with
 * only a status.
 */
export function loginRoutes(deps: {
  config: AccountConfig;
  logins: LoginStore;
  sessions: SessionStore;
  provider: Pick<AccountProvider, "authorizeUrl" | "exchange">;
  now: () => number;
  random: RandomBytes;
  /** A join page's sign-in accepted an invitation: mirror the membership it made. */
  joined?: (account: string, org: string | undefined) => Promise<void>;
}) {
  const { config, logins, sessions, provider, now, random } = deps;
  const secure = config.publicUrl.startsWith("https:") ? "; Secure" : "";
  const bindingCookie = (id: string, value: string, maxAge: number) =>
    `ace_login_${id}=${value}; HttpOnly; SameSite=Lax; Path=/v1/account/callback; Max-Age=${maxAge}${secure}`;

  return {
    /** POST /v1/account/login, with an optional `{ returnTo }`. */
    async start(request: Request): Promise<Response> {
      const body = await loginRequest(request);
      if (!body) return fail(400, "invalid_request");
      const returnTo =
        body.returnTo === undefined
          ? null
          : (allowedReturnTo(body.returnTo, config.allowedOrigins) ?? false);
      if (returnTo === false) return fail(400, "invalid_return");
      const time = now();
      await logins.sweep(time);
      if ((await logins.count(time)) >= MAX_PENDING_LOGINS) return fail(429, "busy");
      const id = opaqueToken(random);
      const secret = opaqueToken(random);
      const expiresAt = time + LOGIN_LIFETIME_MS;
      // A daemon (`ace login`) signs in without a return address, and keeps its session on its
      // disk: that session never speaks for the person (ADR 0190).
      const holder = body.holder ?? (returnTo === null ? "machine" : "person");
      await logins.create(
        await digest(id),
        await digest(secret),
        expiresAt,
        returnTo,
        holder,
        body.org ?? null,
      );
      return json(201, {
        id,
        secret,
        expiresAt,
        loginUrl: `${config.publicUrl}/v1/account/login?id=${id}`,
      });
    },

    /**
     * GET /v1/account/login?id= — the sign-in link. Safe to fetch any number of times (link
     * previews, preloaders): it only shows the button that continues.
     */
    async open(url: URL): Promise<Response> {
      const id = url.searchParams.get("id") ?? "";
      if (!loginId.test(id)) return expired();
      const row = await logins.get(await digest(id), now());
      if (row?.phase !== "new") return expired();
      return continuePage(id, config.allowedOrigins);
    },

    /** POST /v1/account/login/continue — the person's browser, once: binds it, to WorkOS. */
    async continue(request: Request): Promise<Response> {
      const id = await formId(request);
      if (!id) return expired();
      const auth = await pkce(random);
      const binding = opaqueToken(random);
      const row = await logins.get(await digest(id), now());
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
          Location: provider.authorizeUrl(auth.challenge, auth.state, { org: row?.org }),
          "Set-Cookie": bindingCookie(id, binding, LOGIN_LIFETIME_MS / 1000),
        },
      });
    },

    /**
     * POST /v1/orgs/join — the join page's one button (ADR 0206 §1.3): a sign-in in this
     * browser whose authorization URL carries the invitation, so signing in accepts it. No app
     * waits for its session, so none is kept.
     */
    async join(request: Request): Promise<Response> {
      const invitation = await formField(request, "invitation_token", invitationToken);
      if (!invitation) return expired();
      const time = now();
      await logins.sweep(time);
      if ((await logins.count(time)) >= MAX_PENDING_LOGINS)
        return page(429, "ace is busy. Try again in a minute.");
      const id = opaqueToken(random);
      const hash = await digest(id);
      await logins.create(
        hash,
        await digest(opaqueToken(random)),
        time + LOGIN_LIFETIME_MS,
        null,
        "join",
      );
      const auth = await pkce(random);
      const binding = opaqueToken(random);
      const opened = await logins.openBrowser(
        hash,
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
          Location: provider.authorizeUrl(auth.challenge, auth.state, { invitation }),
          "Set-Cookie": bindingCookie(id, binding, LOGIN_LIFETIME_MS / 1000),
        },
      });
    },

    /** GET /v1/account/callback — WorkOS sends the browser back here. */
    async callback(request: Request, url: URL): Promise<Response> {
      const state = url.searchParams.get("state");
      if (!state || state.length > 256) return expired();
      const row = await logins.byState(await digest(state));
      if (!row) return expired();
      // How the sign-in ended: to its return address with only a status, or this page.
      const end = (status: AceSignInReturnStatus, shown: Response) => ended(row, status, shown);
      if (row.phase !== "browser" || row.expires <= now() || !row.binding)
        return end("expired", expired());
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
      if (!verifier) return unverified();
      if (!(await logins.startExchange(row.id, now()))) return end("expired", expired());
      // The binding is spent: clear the cookie whatever happens next.
      const withCookie = (response: Response) => {
        response.headers.set("Set-Cookie", bindingCookie(id, "", 0));
        return response;
      };
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        await logins.fail(row.id);
        return withCookie(
          end("cancelled", page(400, "Sign-in was cancelled. You can keep using ace locally.")),
        );
      }
      let identity;
      try {
        identity = await provider.exchange(code, verifier);
      } catch {
        await logins.fail(row.id);
        return withCookie(
          end("failed", page(502, "Sign-in could not finish. Start again in ace.")),
        );
      }
      // The join page's sign-in only accepts the invitation: no app is waiting for a session.
      if (row.holder === "join") {
        await logins.remove(row.id);
        await deps.joined?.(identity.account.id, identity.organizationId);
        return withCookie(
          page(200, "You've joined the organization. Return to ace. You can close this tab."),
        );
      }
      const token = opaqueToken(random);
      const hash = await digest(token);
      const expiresAt = now() + SESSION_LIFETIME_MS;
      await sessions.put(
        hash,
        identity.account,
        identity.refreshToken,
        expiresAt,
        now(),
        row.holder === "person" || (row.holder === null && row.return_to !== null)
          ? "person"
          : "exposed",
        identity.pictureUrl,
      );
      const grant = AceAccountGrant.parse({ token, expiresAt, account: identity.account });
      // A cancellation or expiry while WorkOS answered wins: the new session is discarded.
      if (!(await logins.complete(row.id, hash, grant, now()))) {
        await sessions.remove(hash);
        return withCookie(end("expired", expired()));
      }
      return withCookie(
        end("signed-in", page(200, "You're signed in. Return to ace. You can close this tab.")),
      );
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
