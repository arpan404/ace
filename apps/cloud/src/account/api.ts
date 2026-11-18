import { ACE_CLIENT_HEADER } from "@ace/protocol/ace-client";
import type { ServerGate } from "@ace/service/client-features";
import type { AccountSetup } from "./config.ts";
import { sealer } from "./crypto.ts";
import type { RandomBytes } from "./crypto.ts";
import { machineCredentialStore } from "./credentials.ts";
import { directoryRoutes } from "./directory.ts";
import { machineSignInRoutes } from "./machine-credential-route.ts";
import { enrollmentStore } from "./enrollments.ts";
import { exchangeKeyPair } from "@ace/account-grant/machine-proof";
import { loginRoutes } from "./login.ts";
import { loginStore } from "./logins.ts";
import { pictureRoute } from "./picture.ts";
import { principalReader } from "./principal.ts";
import { machineStore } from "./machines.ts";
import { bearer, fail, json, secure } from "./respond.ts";
import { sessionReader } from "./session.ts";
import { sessionStore } from "./sessions.ts";
import { workos } from "./workos.ts";

/** Paths the account API owns; everything else on the Worker is the relay. */
export function isAccountPath(pathname: string): boolean {
  return pathname.startsWith("/v1/");
}

/** The sign-in page's form posts here, from the backend's own origin. */
const continuePath = "/v1/account/login/continue";
const loginClaim = /^\/v1\/account\/login\/([A-Za-z0-9_-]{43})$/;
const machinePath = /^\/v1\/machines\/([A-Z2-7]{52})$/;

/**
 * The account HTTP API. One instance per isolate: it holds the in-flight session refreshes
 * that concurrent requests share.
 */
export function accountApi(
  setup: AccountSetup,
  deps: {
    db: D1Database;
    fetch: typeof fetch;
    now: () => number;
    random: RandomBytes;
    /** A machine left the account's list: one still registered on the relay lists itself again. */
    forgotten?: (hostId: string, accountId: string) => Promise<void>;
  },
) {
  if (setup.status !== "ready")
    return {
      handle: async () => secure(fail(503, "account_not_configured"), undefined),
      sweep: async () => {},
    };
  const { config } = setup;
  const { now, random } = deps;
  // The key a daemon proves its host key against (ADR 0190), published with the grant keys.
  const exchangeKey = exchangeKeyPair(
    Uint8Array.from(config.encryptionKey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)),
  );
  const keys = { ...setup.keys, exchangeKey: exchangeKey.publicKey };
  const seal = sealer(config.encryptionKey, random);
  const sessions = sessionStore(deps.db, seal);
  const provider = workos(config, deps.fetch);
  const reader = sessionReader({ store: sessions, provider, now });
  const credentials = machineCredentialStore(deps.db);
  const principals = principalReader({ sessions: reader, credentials, now });
  const enrollments = enrollmentStore(deps.db);
  const machineSignIn = machineSignInRoutes({
    db: deps.db,
    principals,
    sessions: reader,
    sessionStore: sessions,
    credentials,
    enrollments,
    exchangeKey,
    now,
    random,
  });
  const picture = pictureRoute({ sessions, fetch: deps.fetch, now });
  const logins = loginStore(deps.db, seal);
  const loginFor = (publicUrl: string) => {
    const selected = { ...config, publicUrl };
    return loginRoutes({
      config: selected,
      logins,
      sessions,
      provider: workos(selected, deps.fetch),
      now,
      random,
    });
  };
  // The canonical URL still serves deployments with a single public address. Multi-host
  // deployments select only configured origins, never a caller-supplied Host or Origin.
  const canonicalLogin = loginFor(config.publicUrl);
  const hostLogins = new Map(config.publicOrigins?.map((origin) => [origin, loginFor(origin)]));
  const directory = directoryRoutes({
    principals,
    sessionStore: sessions,
    legacyPersonUntil: config.legacyPersonUntil,
    machines: machineStore(deps.db),
    ...(deps.forgotten ? { forgotten: deps.forgotten } : {}),
    keys,
    signingKey: config.grantKey,
    now,
    issuer: new URL(config.publicUrl).host,
  });

  async function route(
    request: Request,
    url: URL,
    login: ReturnType<typeof loginRoutes>,
  ): Promise<Response> {
    const { pathname } = url;
    const method = request.method;
    if (pathname === "/v1/keys" && method === "GET") return directory.keys();
    if (pathname === "/v1/grants" && method === "POST") return directory.grant(request);
    if (pathname === "/v1/machine-credentials" && method === "POST")
      return machineSignIn.exchange(request);
    if (pathname === "/v1/machine-enrollments" && method === "POST")
      return machineSignIn.enroll(request);
    if (pathname === "/v1/machines" && method === "GET") return directory.list(request);
    const machine = pathname.match(machinePath)?.[1];
    if (machine && method === "DELETE") return directory.forget(request, machine);
    if (pathname === "/v1/account/login" && method === "POST") return login.start(request);
    if (pathname === "/v1/account/login" && method === "GET") return login.open(url);
    if (pathname === "/v1/account/callback" && method === "GET")
      return login.callback(request, url);
    const claim = pathname.match(loginClaim)?.[1];
    if (claim && (method === "GET" || method === "DELETE")) return login.claim(request, claim);
    if (pathname === "/v1/account/picture" && method === "GET") return picture(request);
    if (pathname === "/v1/account/session" && (method === "GET" || method === "DELETE")) {
      const token = bearer(request);
      if (!token) return fail(401, "unauthenticated");
      if (method === "DELETE") {
        await principals.revoke(token);
        return json(200, { ok: true });
      }
      // A machine credential reads as the session it lives on, without saying more of it.
      const principal = await principals.read(token);
      return principal
        ? json(200, { account: principal.account, expiresAt: principal.expiresAt })
        : fail(401, "unauthenticated");
    }
    return fail(404, "not_found");
  }

  return {
    /** Drops expired sign-ins, sessions and machine credentials. */
    sweep: async () => {
      await logins.sweep(now());
      await credentials.sweep(now());
      await enrollments.sweep(now());
    },
    /**
     * `limited` is the caller's rate-limit verdict for this client address; `_gate` says which
     * gated features the calling app supports (ADR 0189); none is gated yet.
     */
    async handle(request: Request, limited: boolean, _gate: ServerGate): Promise<Response> {
      const url = new URL(request.url);
      const login = config.publicOrigins ? hostLogins.get(url.origin) : canonicalLogin;
      if (!login) return secure(fail(403, "origin_denied"), undefined);
      const publicUrl = config.publicOrigins ? url.origin : config.publicUrl;
      const origin = request.headers.get("Origin") ?? undefined;
      // The continue form comes only from the backend's own sign-in page: another site cannot
      // post a login id it holds into the person's browser and on to WorkOS.
      if (request.method === "POST" && url.pathname === continuePath) {
        if (origin !== publicUrl) return secure(fail(403, "origin_denied"), undefined);
        if (limited) return secure(fail(429, "rate_limited"), undefined);
        try {
          return secure(await login.continue(request), undefined);
        } catch {
          return secure(fail(503, "account_unavailable"), undefined);
        }
      }
      if (origin && !config.allowedOrigins.some((allowed) => allowed === origin))
        return secure(fail(403, "origin_denied"), undefined);
      if (limited) return secure(fail(429, "rate_limited"), origin);
      if (request.method === "OPTIONS") {
        const response = new Response(null, { status: 204 });
        response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        response.headers.set(
          "Access-Control-Allow-Headers",
          `Authorization, Content-Type, ${ACE_CLIENT_HEADER}`,
        );
        return secure(response, origin);
      }
      if (request.url.length > 4096) return secure(fail(414, "invalid_request"), origin);
      try {
        return secure(await route(request, url, login), origin);
      } catch {
        return secure(fail(503, "account_unavailable"), origin);
      }
    },
  };
}
export type AccountApi = ReturnType<typeof accountApi>;
