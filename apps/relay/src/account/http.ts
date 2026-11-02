import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AceAccountGrant, type AceAccount } from "@ace/protocol/ace-account";
import { z } from "zod";
import type { AccountConfig } from "./config.ts";
import { accountStore, digest } from "./store.ts";
import { workosProvider, type AccountProvider } from "./workos.ts";

const lifetime = 10 * 60_000;
const sessionLifetime = 7 * 24 * 60 * 60_000;
const opaque = /^[A-Za-z0-9_-]{43}$/;
type Flow = {
  secret: string;
  expiresAt: number;
  browser?: { state: string; binding: string; verifier: string };
  grant?: z.infer<typeof AceAccountGrant>;
  exchanging?: boolean;
  failed?: boolean;
  claimed?: boolean;
};
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const bearer = (request: IncomingMessage) => {
  const value = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  return value;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
function page(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ace sign-in</title><body><main><h1>ace</h1><p>${message}</p></main></body></html>`,
  );
}

/** Account HTTP shares the relay listener; it never handles the daemon's encrypted payloads. */
export function accountHttp(options: {
  config: AccountConfig;
  now: () => number;
  provider?: AccountProvider;
  createSecret?: () => string;
}) {
  const { config, now } = options;
  const provider = options.provider ?? workosProvider(config);
  const store = accountStore(config.dataDir, Buffer.from(config.encryptionKey, "hex"));
  const secret = options.createSecret ?? (() => randomBytes(32).toString("base64url"));
  const flows = new Map<string, Flow>();
  const refreshes = new Map<
    string,
    Promise<{ account: AceAccount; expiresAt: number } | undefined>
  >();
  const requests = new Map<string, { start: number; count: number }>();
  let closed = false;

  function sweep() {
    for (const [id, flow] of flows)
      if (flow.expiresAt <= now()) {
        if (flow.grant && !flow.claimed) store.remove(flow.grant.token);
        flows.delete(id);
      }
    for (const [ip, entry] of requests) if (entry.start + 60_000 <= now()) requests.delete(ip);
    store.sweep(now());
  }
  async function session(token: string) {
    const pending = refreshes.get(token);
    if (pending) return pending;
    const run = (async () => {
      const stored = store.get(token, now());
      if (!stored) return undefined;
      try {
        const identity = await provider.refresh(stored.refresh);
        if (closed || now() >= stored.expiresAt || identity.account.id !== stored.account.id) {
          if (!closed) store.remove(token);
          return undefined;
        }
        if (!store.rotate(token, identity.account, identity.refreshToken)) return undefined;
        return { account: identity.account, expiresAt: stored.expiresAt };
      } catch (error) {
        const failure = z.object({ code: z.string().optional() }).safeParse(error);
        if (!closed && failure.success && failure.data.code === "invalid_grant") {
          store.remove(token);
          return undefined;
        }
        throw error;
      }
    })();
    refreshes.set(token, run);
    try {
      return await run;
    } finally {
      refreshes.delete(token);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const origin = request.headers.origin;
    if (origin) {
      if (!config.allowedOrigins.includes(origin))
        return json(response, 403, { error: "origin_denied" });
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    const ip = request.socket.remoteAddress ?? "unknown";
    const time = now();
    let rate = requests.get(ip);
    if (!rate || rate.start + 60_000 <= time) {
      if (requests.size >= 4096) sweep();
      if (requests.size >= 4096 && !rate) return json(response, 429, { error: "busy" });
      rate = { start: time, count: 0 };
      requests.set(ip, rate);
    }
    if (++rate.count > 120) return json(response, 429, { error: "rate_limited" });
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.writeHead(204);
      response.end();
      return;
    }
    if ((request.url?.length ?? 0) > 4096) return json(response, 414, { error: "invalid_request" });
    const url = new URL(request.url ?? "/", config.publicUrl);
    if (url.pathname === "/v1/account/login" && request.method === "POST") {
      sweep();
      if (flows.size >= 256) return json(response, 429, { error: "busy" });
      const id = secret(),
        claim = secret(),
        expiresAt = time + lifetime;
      flows.set(id, { secret: digest(claim), expiresAt });
      return json(response, 201, {
        id,
        secret: claim,
        expiresAt,
        loginUrl: `${config.publicUrl}/v1/account/login?id=${id}`,
      });
    }
    if (url.pathname === "/v1/account/login" && request.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const flow = flows.get(id);
      if (
        !flow ||
        flow.expiresAt <= time ||
        flow.browser ||
        flow.grant ||
        flow.exchanging ||
        flow.failed
      )
        return page(response, 410, "This sign-in has expired. Start again in ace.");
      flow.exchanging = true;
      const auth = await provider.authorize();
      if (closed || flow.expiresAt <= now())
        return page(response, 410, "This sign-in has expired. Start again in ace.");
      const binding = secret();
      flow.browser = { state: auth.state, binding: digest(binding), verifier: auth.codeVerifier };
      flow.exchanging = false;
      response.setHeader(
        "Set-Cookie",
        `ace_login_${id}=${binding}; HttpOnly; SameSite=Lax; Path=/v1/account/callback; Max-Age=600${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`,
      );
      response.writeHead(302, { Location: auth.url });
      response.end();
      return;
    }
    if (url.pathname === "/v1/account/callback" && request.method === "GET") {
      const state = url.searchParams.get("state");
      const entry = [...flows].find(([, flow]) => state && flow.browser?.state === state);
      if (!entry) return page(response, 400, "Sign-in could not be verified. Start again in ace.");
      const [id, flow] = entry;
      const browser = flow.browser;
      const cookie = request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`ace_login_${id}=`))
        ?.split("=")[1];
      if (
        !browser ||
        flow.expiresAt <= time ||
        flow.exchanging ||
        !cookie ||
        !equal(digest(cookie), browser.binding)
      )
        return page(response, 400, "Sign-in could not be verified. Start again in ace.");
      flow.exchanging = true;
      delete flow.browser;
      response.setHeader(
        "Set-Cookie",
        `ace_login_${id}=; HttpOnly; SameSite=Lax; Path=/v1/account/callback; Max-Age=0${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`,
      );
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) {
        flow.failed = true;
        return page(response, 400, "Sign-in was cancelled. You can keep using ace locally.");
      }
      try {
        const identity = await provider.exchange(code, browser.verifier);
        if (closed || flow.expiresAt <= now() || flows.get(id) !== flow)
          return page(response, 410, "This sign-in has expired. Start again in ace.");
        const token = secret(),
          expiresAt = now() + sessionLifetime;
        store.put(token, identity.account, identity.refreshToken, expiresAt);
        flow.grant = AceAccountGrant.parse({ token, expiresAt, account: identity.account });
        return page(response, 200, "You're signed in. Return to ace. You can close this tab.");
      } catch {
        flow.failed = true;
        return page(response, 502, "Sign-in could not finish. Start again in ace.");
      }
    }
    const match = url.pathname.match(/^\/v1\/account\/login\/([A-Za-z0-9_-]{43})$/);
    if (match?.[1] && (request.method === "GET" || request.method === "DELETE")) {
      const flow = flows.get(match[1]);
      const claim = bearer(request);
      if (!flow || flow.expiresAt <= time || !claim || !equal(digest(claim), flow.secret))
        return json(response, 401, { error: "invalid_login" });
      if (request.method === "DELETE") {
        if (flow.grant) store.remove(flow.grant.token);
        flows.delete(match[1]);
        return json(response, 200, { ok: true });
      }
      if (flow.failed) return json(response, 410, { error: "login_failed" });
      if (!flow.grant) return json(response, 200, { status: "pending" });
      if (!store.get(flow.grant.token, time)) {
        flows.delete(match[1]);
        return json(response, 401, { error: "invalid_login" });
      }
      flow.claimed = true;
      return json(response, 200, { status: "complete", session: flow.grant });
    }
    if (url.pathname === "/v1/account/session") {
      const token = bearer(request);
      if (!token || !opaque.test(token)) return json(response, 401, { error: "unauthenticated" });
      if (request.method === "DELETE") {
        store.remove(token);
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET") {
        const result = await session(token);
        return result
          ? json(response, 200, result)
          : json(response, 401, { error: "unauthenticated" });
      }
    }
    return json(response, 404, { error: "not_found" });
  }
  return {
    handle(request: IncomingMessage, response: ServerResponse) {
      void handle(request, response).catch(() => {
        if (!response.headersSent) json(response, 503, { error: "account_unavailable" });
        else response.end();
      });
    },
    sweep,
    close() {
      closed = true;
      for (const flow of flows.values())
        if (flow.grant && !flow.claimed) store.remove(flow.grant.token);
      flows.clear();
      store.close();
    },
  };
}
