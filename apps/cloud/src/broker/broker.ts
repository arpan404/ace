import { encodeBase64url, verifyCloudGrant } from "@ace/account-grant";
import type { GrantKeySet } from "@ace/account-grant";
import { jsonBody } from "../account/respond.ts";
import type { App, Client, ConfiguredApp } from "./apps.ts";
import { maker } from "./maker.ts";
import type { MakerResult } from "./maker.ts";
import { page } from "./page.ts";
import { SealError, publicKeyBytes, seal } from "./seal.ts";
import type { SealPurpose } from "./seal.ts";
import { SIGN_IN_SECONDS, isChallenge } from "./sign-ins.ts";
import type { SignInDirectory } from "./store.ts";
import { FinishRequest, REFUSALS, RefreshRequest, StartRequest } from "./wire.ts";
import type { Refusal } from "./wire.ts";

/**
 * Spade's connector sign-in broker (ADR 0141, `spade/docs/cloud.md`), for apps whose OAuth needs
 * a client secret. Spade starts a sign-in with a PKCE challenge and a one-time key, the maker
 * redirects back here, Spade finishes with its verifier, and the broker exchanges the code with
 * its secret and answers with the tokens sealed to Spade's key. Requests carry the person's
 * cloud credential (ADR 0111 signing, cloud audience). Nothing is kept but sign-ins in progress;
 * logs name the account, the app and the outcome, never a token, code, verifier, state or secret.
 */

export const CALLBACK_PATH = "/v1/oauth/callback";
const MOST_BODY_BYTES = 16 * 1024;
const RETRY_AFTER_SECONDS = 10;

/** One log line. Its fields are all it can carry, so no token can reach the logs. */
export type BrokerLog = {
  outcome: string;
  account?: string;
  app?: string;
  step?: "start" | "callback" | "finish" | "refresh" | "exchange";
};

export type BrokerDeps = {
  /** The apps and their clients; undefined when the configured list doesn't read. */
  apps: readonly ConfiguredApp[] | undefined;
  /** ace cloud's account settings, when ready: the grant keys and its public origin. */
  account: { keys: GrantKeySet; publicUrl: string } | undefined;
  signIns: SignInDirectory;
  fetch: typeof fetch;
  now: () => number;
  random: (length: number) => Uint8Array;
  /** Whether this caller's address, or this account, is over its budget. */
  limited: { address(request: Request): Promise<boolean>; account(id: string): Promise<boolean> };
  log: (entry: BrokerLog) => void;
};

export function isBrokerPath(pathname: string): boolean {
  return pathname.startsWith("/v1/oauth/");
}

const step = /^\/v1\/oauth\/([a-z0-9-]{1,64})\/(start|finish|refresh)$/;
const callbackPath = /^\/v1\/oauth\/callback\/([a-z0-9-]{1,64})$/;

function refuse(code: Refusal): Response {
  const response = Response.json({ error: code }, { status: REFUSALS[code] });
  response.headers.set("Cache-Control", "no-store");
  if (code === "rate_limited") response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return response;
}

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

type Caller = { account: string; app: App; client: Client };

export function broker(deps: BrokerDeps) {
  const { signIns, now, log } = deps;
  const tokens = maker(deps.fetch);
  const randomValue = () => encodeBase64url(deps.random(32));
  const redirect = (publicUrl: string, app: App) =>
    `${publicUrl.replace(/\/$/, "")}${CALLBACK_PATH}/${app.id}`;

  /** Who is asking: the account a valid cloud credential names, within budget, and the app. */
  async function caller(request: Request, appId: string): Promise<Caller | Response> {
    if (await deps.limited.address(request)) return refuse("rate_limited");
    const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) return refuse("unauthorized");
    if (!deps.account) {
      log({ outcome: "account_unavailable" });
      return refuse("account_unavailable");
    }
    let account: string;
    try {
      account = verifyCloudGrant(token, deps.account.keys, now()).account;
    } catch {
      log({ outcome: "unauthorized" });
      return refuse("unauthorized");
    }
    if (await deps.limited.account(account)) {
      log({ account, app: appId, outcome: "rate_limited" });
      return refuse("rate_limited");
    }
    if (!deps.apps) return refuse("app_unavailable");
    const configured = deps.apps.find((each) => each.app.id === appId);
    if (!configured) return refuse("unknown_app");
    if (!configured.client) {
      log({ account, app: appId, outcome: "app_unavailable" });
      return refuse("app_unavailable");
    }
    return { account, app: configured.app, client: configured.client };
  }

  function authorizationUrl(caller: Caller, publicUrl: string, state: string, challenge: string) {
    const url = new URL(caller.app.authorization_endpoint);
    const query = url.searchParams;
    query.append("response_type", "code");
    query.append("client_id", caller.client.id);
    query.append("redirect_uri", redirect(publicUrl, caller.app));
    query.append("state", state);
    query.append("code_challenge", challenge);
    query.append("code_challenge_method", "S256");
    query.append("resource", caller.app.resource);
    if (caller.app.scopes.length) query.append("scope", caller.app.scopes.join(" "));
    return url.toString();
  }

  async function start(request: Request, appId: string): Promise<Response> {
    const who = await caller(request, appId);
    if (who instanceof Response) return who;
    const body = StartRequest.safeParse(await jsonBody(request, MOST_BODY_BYTES));
    if (!body.success) return refuse("invalid_request");
    const { code_challenge: challenge, public_key: publicKey } = body.data;
    if (!isChallenge(challenge) || !publicKeyBytes(publicKey)) return refuse("invalid_request");
    const { store, route } = signIns.forAccount(who.account);
    const handle = randomValue();
    const state = `${route}.${randomValue()}`;
    const at = now();
    await store.begin(
      {
        handle,
        state,
        account: who.account,
        app: who.app.id,
        challenge,
        publicKey,
        startedMs: at,
        outcome: { kind: "waiting" },
      },
      at,
    );
    log({ account: who.account, app: who.app.id, step: "start", outcome: "started" });
    // `deps.account` is set: `caller` verified the credential with it.
    const publicUrl = deps.account?.publicUrl ?? "";
    return answer(200, {
      sign_in: handle,
      authorization_url: authorizationUrl(who, publicUrl, state, challenge),
      expires_in: SIGN_IN_SECONDS,
      issuer: who.app.issuer,
      client_id: who.client.id,
    });
  }

  async function callback(request: Request, url: URL, callbackApp: string): Promise<Response> {
    if (await deps.limited.address(request)) return refuse("rate_limited");
    // The first of each parameter; a repeated one is ignored.
    const query = url.searchParams;
    const state = query.get("state");
    if (!state) return page("invalid");
    const store = signIns.forState(state);
    const app = store ? await store.appOf(state) : undefined;
    if (!store || !app) {
      log({ step: "callback", outcome: "unknown_state" });
      return page("invalid");
    }
    if (app !== callbackApp) return page("invalid");
    const configured = deps.apps?.find((each) => each.app.id === app)?.app;
    // RFC 9207: an `iss` naming another server is an answer mixed up between servers.
    const iss = query.get("iss");
    const issuerOk = configured
      ? iss === null
        ? !configured.authorization_response_iss_parameter_supported
        : iss === configured.issuer
      : false;
    const verdict = await store.callback(
      {
        state,
        app: callbackApp,
        code: query.get("code") || undefined,
        declined: query.has("error"),
        issuerOk,
      },
      now(),
    );
    switch (verdict.kind) {
      case "accepted":
        log({ account: verdict.account, app, step: "callback", outcome: "returned" });
        return page("signed_in");
      case "declined":
        log({
          account: verdict.account,
          app,
          step: "callback",
          outcome: issuerOk ? "declined" : "wrong_issuer",
        });
        return page("declined");
      default:
        log({ app, step: "callback", outcome: "replayed_or_expired" });
        return page("invalid");
    }
  }

  async function finish(request: Request, appId: string): Promise<Response> {
    const who = await caller(request, appId);
    if (who instanceof Response) return who;
    const body = FinishRequest.safeParse(await jsonBody(request, MOST_BODY_BYTES));
    if (!body.success) return refuse("invalid_request");
    const { store } = signIns.forAccount(who.account);
    const verdict = await store.finish(
      {
        handle: body.data.sign_in,
        account: who.account,
        app: who.app.id,
        verifier: body.data.code_verifier,
      },
      now(),
    );
    const refusal = (code: Refusal) => {
      log({ account: who.account, app: who.app.id, step: "finish", outcome: code });
      return refuse(code);
    };
    switch (verdict.kind) {
      case "waiting":
        return answer(202, { status: "waiting" });
      case "unknown":
        return refusal("unknown_sign_in");
      case "expired":
        return refusal("expired");
      case "wrong_verifier":
        return refusal("wrong_verifier");
      case "declined":
        return refusal("declined");
      case "ready": {
        const publicUrl = deps.account?.publicUrl ?? "";
        const result = await tokens.exchange(
          who.app,
          who.client,
          verdict.code,
          body.data.code_verifier,
          redirect(publicUrl, who.app),
        );
        return sealedAnswer(who, verdict.publicKey, result, "finish");
      }
    }
  }

  async function refresh(request: Request, appId: string): Promise<Response> {
    const who = await caller(request, appId);
    if (who instanceof Response) return who;
    const body = RefreshRequest.safeParse(await jsonBody(request, MOST_BODY_BYTES));
    if (!body.success || !publicKeyBytes(body.data.public_key)) return refuse("invalid_request");
    const result = await tokens.refresh(who.app, who.client, body.data.refresh_token);
    return sealedAnswer(who, body.data.public_key, result, "refresh");
  }

  /** The maker's answer sealed to Spade's key, or why there is none. */
  function sealedAnswer(
    who: Caller,
    publicKey: string,
    result: MakerResult,
    purpose: SealPurpose,
  ): Response {
    const entry = {
      account: who.account,
      app: who.app.id,
      step: purpose === "finish" ? "exchange" : "refresh",
    } as const;
    if (!result.ok) {
      log({ ...entry, outcome: result.why });
      return refuse(result.why);
    }
    let sealed;
    try {
      sealed = seal(publicKey, result.tokens, { app: who.app.id, purpose }, deps.random(32));
    } catch (error) {
      if (!(error instanceof SealError)) throw error;
      log({ ...entry, outcome: "unsealable" });
      return refuse("invalid_request");
    }
    log({ ...entry, outcome: "ok" });
    return answer(200, purpose === "finish" ? { status: "done", sealed } : { sealed });
  }

  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const back = callbackPath.exec(url.pathname)?.[1];
      if (back) {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        return callback(request, url, back);
      }
      const match = step.exec(url.pathname);
      if (!match?.[1] || !match[2]) return refuse("unknown_app");
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const [, app, which] = match;
      if (which === "start") return start(request, app);
      if (which === "finish") return finish(request, app);
      return refresh(request, app);
    },
  };
}
