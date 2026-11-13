import { beforeEach, expect, it } from "vitest";
import { grantPublicKey } from "@ace/account-grant";
import type { App } from "./apps.ts";
import { broker } from "./broker.ts";
import type { BrokerLog } from "./broker.ts";
import { open } from "./seal.ts";
import type { SealPurpose } from "./seal.ts";
import { SIGN_IN_MS } from "./sign-ins.ts";
import { credentials, memorySignIns, spadeSide } from "./testing.ts";

const START = 1_800_000_000_000;
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const asana: App = {
  id: "asana",
  name: "Asana",
  issuer: "https://app.asana.example",
  authorization_response_iss_parameter_supported: false,
  authorization_endpoint: "https://app.asana.example/authorize",
  token_endpoint: "https://app.asana.example/token",
  client_auth: "client_secret_post",
  scopes: ["default"],
  resource: "https://mcp.asana.example/mcp",
  client_id_env: "ASANA_ID",
  client_secret_env: "ASANA_SECRET",
};
const box: App = {
  ...asana,
  id: "box",
  issuer: "https://box.example",
  authorization_response_iss_parameter_supported: true,
  token_endpoint: "https://box.example/token",
  client_auth: "client_secret_basic",
  scopes: [],
};
const unset: App = { ...asana, id: "canva" };

type MakerCall = { url: string; form: URLSearchParams; authorization: string | null };

let clock: number;
let calls: MakerCall[];
let makerAnswer: () => Response;
let logs: BrokerLog[];
let overBudget: Set<string>;
let signIns: ReturnType<typeof memorySignIns>;
let accountReady: boolean;
let service: ReturnType<typeof broker>;
const grants = credentials(key, START);

beforeEach(() => {
  clock = START;
  calls = [];
  logs = [];
  overBudget = new Set();
  accountReady = true;
  signIns = memorySignIns();
  makerAnswer = () =>
    Response.json({
      access_token: "access-secret-1",
      refresh_token: "refresh-secret-1",
      expires_in: 3600,
      token_type: "bearer",
      user: { email: "person@example.com" },
    });
  let random = 0;
  service = broker({
    apps: [
      { app: asana, client: { id: "asana-client", secret: "asana-client-secret" } },
      { app: box, client: { id: "box client", secret: "box:secret" } },
      { app: unset, client: undefined },
    ],
    get account() {
      return accountReady
        ? { keys: { keys: [grantPublicKey(key)] }, publicUrl: "https://cloud.acehq.dev" }
        : undefined;
    },
    signIns,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        form: new URLSearchParams(String(init?.body ?? "")),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return makerAnswer();
    },
    now: () => clock,
    random: (length) => new Uint8Array(length).fill(++random),
    limited: {
      address: async (request) =>
        overBudget.has(request.headers.get("CF-Connecting-IP") ?? "unknown"),
      account: async (id) => overBudget.has(id),
    },
    log: (entry) => logs.push(entry),
  });
});

function post(app: string, step: string, body: unknown, grant = grants.cloud("user_a")) {
  return service.handle(
    new Request(`https://cloud.acehq.dev/v1/oauth/${app}/${step}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function returnTo(app: string, query: Record<string, string>) {
  return service.handle(
    new Request(`https://cloud.acehq.dev/v1/oauth/callback/${app}?${new URLSearchParams(query)}`),
  );
}

async function started(app = "asana", account = "user_a", seed = 1) {
  const spade = spadeSide(seed);
  const response = await post(
    app,
    "start",
    { code_challenge: spade.challenge, public_key: spade.publicKey },
    grants.cloud(account),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    sign_in: string;
    authorization_url: string;
    expires_in: number;
    issuer: string;
    client_id: string;
  };
  const state = new URL(body.authorization_url).searchParams.get("state") ?? "";
  const finish = (grant = grants.cloud(account), verifier = spade.verifier) =>
    post(app, "finish", { sign_in: body.sign_in, code_verifier: verifier }, grant);
  return { spade, body, state, finish };
}

async function opened(
  response: Response,
  app: string,
  purpose: SealPurpose,
  privateKey: Uint8Array,
) {
  const body = (await response.json()) as { sealed: { epk: string; ciphertext: string } };
  return JSON.parse(new TextDecoder().decode(open(body.sealed, { app, purpose }, privateKey)));
}

it("a sign-in started by Spade comes back sealed to Spade's key after the person signs in", async () => {
  const { spade, body, state, finish } = await started();
  const url = new URL(body.authorization_url);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "asana-client",
    redirect_uri: "https://cloud.acehq.dev/v1/oauth/callback/asana",
    code_challenge: spade.challenge,
    code_challenge_method: "S256",
    resource: "https://mcp.asana.example/mcp",
    scope: "default",
  });
  expect(body).toMatchObject({ expires_in: 600, issuer: asana.issuer, client_id: "asana-client" });

  const waiting = await finish();
  expect(waiting.status).toBe(202);
  expect(await waiting.json()).toEqual({ status: "waiting" });

  const page = await returnTo("asana", { state, code: "the-code" });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Signed in. You can close this tab.");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");

  const done = await finish();
  expect(done.status).toBe(200);
  const answer = done.clone();
  expect(((await answer.json()) as { status: string }).status).toBe("done");
  expect(await opened(done, "asana", "finish", spade.privateKey)).toEqual({
    access_token: "access-secret-1",
    refresh_token: "refresh-secret-1",
    expires_in: 3600,
    token_type: "bearer",
  });
  expect(calls).toHaveLength(1);
  expect(Object.fromEntries(calls[0]!.form)).toEqual({
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: "https://cloud.acehq.dev/v1/oauth/callback/asana",
    code_verifier: spade.verifier,
    resource: "https://mcp.asana.example/mcp",
    client_id: "asana-client",
    client_secret: "asana-client-secret",
  });
  expect(signIns.held()).toBe(0);
});

it("a callback or a finish can't be replayed", async () => {
  const { state, finish } = await started();
  expect((await returnTo("asana", { state, code: "first" })).status).toBe(200);
  expect((await returnTo("asana", { state, code: "second" })).status).toBe(400);
  expect((await finish()).status).toBe(200);
  expect(calls[0]!.form.get("code")).toBe("first");
  const again = await finish();
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "unknown_sign_in" });
  expect((await returnTo("asana", { state, code: "third" })).status).toBe(400);
  expect(calls).toHaveLength(1);
});

it("a sign-in is bound to its app: another app's callback or finish finds nothing", async () => {
  const { body, state, spade, finish } = await started("asana");
  expect((await returnTo("box", { state, code: "c" })).status).toBe(400);
  expect((await returnTo("asana", { state, code: "c" })).status).toBe(200);
  const other = await post("box", "finish", {
    sign_in: body.sign_in,
    code_verifier: spade.verifier,
  });
  expect(await other.json()).toEqual({ error: "unknown_sign_in" });
  expect((await finish()).status).toBe(200);
});

it("another account can't finish a sign-in, and doesn't spoil it", async () => {
  const { state, finish } = await started("asana", "user_a");
  await returnTo("asana", { state, code: "c" });
  const stolen = await finish(grants.cloud("user_b"));
  expect(stolen.status).toBe(404);
  expect((await finish()).status).toBe(200);
});

it("a wrong verifier is refused and drops the sign-in", async () => {
  const { state, finish } = await started();
  await returnTo("asana", { state, code: "c" });
  const wrong = await finish(undefined, spadeSide(7).verifier);
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toEqual({ error: "wrong_verifier" });
  expect(await (await finish()).json()).toEqual({ error: "unknown_sign_in" });
  expect(calls).toHaveLength(0);
});

it("an answer naming another issuer, or none where the app sends one, counts as declined", async () => {
  const wrongIssuer = await started("asana");
  const page = await returnTo("asana", {
    state: wrongIssuer.state,
    code: "c",
    iss: "https://evil.example",
  });
  expect(await page.text()).toContain("cancelled");
  const refused = await wrongIssuer.finish();
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "declined" });

  const missing = await started("box", "user_a", 3);
  await returnTo("box", { state: missing.state, code: "c" });
  expect((await missing.finish()).status).toBe(409);

  const right = await started("box", "user_a", 5);
  await returnTo("box", { state: right.state, code: "c", iss: box.issuer });
  expect((await right.finish()).status).toBe(200);
  expect(calls).toHaveLength(1);
});

it("the person declining at the app ends the sign-in as declined", async () => {
  const { state, finish } = await started();
  await returnTo("asana", { state, error: "access_denied" });
  expect(await (await finish()).json()).toEqual({ error: "declined" });
});

it("a sign-in runs out after ten minutes, for the callback and for Spade", async () => {
  const late = await started("asana", "user_a", 1);
  clock = START + SIGN_IN_MS;
  expect((await returnTo("asana", { state: late.state, code: "c" })).status).toBe(400);

  clock = START;
  const slow = await started("asana", "user_a", 3);
  await returnTo("asana", { state: slow.state, code: "c" });
  clock = START + SIGN_IN_MS;
  const expired = await slow.finish(credentials(key, clock).cloud("user_a"));
  expect(expired.status).toBe(410);
  expect(await expired.json()).toEqual({ error: "expired" });
  expect(signIns.held()).toBe(0);
});

it("an account holds five sign-ins at once and a sixth drops the oldest", async () => {
  const first = await started("asana", "user_a", 1);
  for (let seed = 3; seed <= 11; seed += 2) await started("asana", "user_a", seed);
  expect(await (await first.finish()).json()).toEqual({ error: "unknown_sign_in" });
  expect(signIns.held()).toBe(5);
});

it("only a cloud credential from ace's account keys is accepted", async () => {
  const spade = spadeSide(1);
  const body = { code_challenge: spade.challenge, public_key: spade.publicKey };
  for (const grant of [grants.machine("user_a"), grants.device("user_a"), "", "x.y"]) {
    const refused = await post("asana", "start", body, grant);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthorized" });
  }
  const forged = credentials({ id: "k1", privateKey: new Uint8Array(32).fill(3) }, START);
  expect((await post("asana", "start", body, forged.cloud("user_a"))).status).toBe(401);
  clock = START + 10 * 60_000;
  expect((await post("asana", "start", body)).status).toBe(401);
  clock = START;
  accountReady = false;
  const away = await post("asana", "start", body);
  expect(away.status).toBe(503);
  expect(await away.json()).toEqual({ error: "account_unavailable" });
});

it("an unknown app, or one without its client set, is refused", async () => {
  const spade = spadeSide(1);
  const body = { code_challenge: spade.challenge, public_key: spade.publicKey };
  expect(await (await post("trello", "start", body)).json()).toEqual({ error: "unknown_app" });
  const unsetApp = await post("canva", "start", body);
  expect(unsetApp.status).toBe(503);
  expect(await unsetApp.json()).toEqual({ error: "app_unavailable" });
});

it("a malformed challenge, key or body is refused before anything is kept", async () => {
  const spade = spadeSide(1);
  for (const body of [
    { code_challenge: "short", public_key: spade.publicKey },
    { code_challenge: spade.challenge, public_key: "not-a-key" },
    { code_challenge: spade.challenge, public_key: spade.publicKey, extra: 1 },
  ])
    expect(await (await post("asana", "start", body)).json()).toEqual({ error: "invalid_request" });
  expect(signIns.held()).toBe(0);
});

it("an address or account over its budget is answered 429 with Retry-After", async () => {
  const spade = spadeSide(1);
  const body = { code_challenge: spade.challenge, public_key: spade.publicKey };
  overBudget.add("user_a");
  const account = await post("asana", "start", body);
  expect(account.status).toBe(429);
  expect(account.headers.get("Retry-After")).toBe("10");
  overBudget.clear();
  overBudget.add("unknown");
  expect((await post("asana", "start", body)).status).toBe(429);
  expect((await returnTo("asana", { state: "x", code: "c" })).status).toBe(429);
});

it("a refresh goes through the app with the client secret and comes back sealed", async () => {
  const spade = spadeSide(1);
  const response = await post("box", "refresh", {
    refresh_token: "refresh-secret-0",
    public_key: spade.publicKey,
  });
  expect(response.status).toBe(200);
  expect(await opened(response, "box", "refresh", spade.privateKey)).toMatchObject({
    access_token: "access-secret-1",
  });
  expect(Object.fromEntries(calls[0]!.form)).toEqual({
    grant_type: "refresh_token",
    refresh_token: "refresh-secret-0",
    resource: box.resource,
  });
  // RFC 6749 section 2.3.1: form-encoded, then Basic.
  expect(calls[0]!.authorization).toBe(`Basic ${btoa("box+client:box%3Asecret")}`);
});

it("the app refusing is 'refused', and an unusable answer is 'upstream'", async () => {
  const spade = spadeSide(1);
  const body = { refresh_token: "r", public_key: spade.publicKey };
  makerAnswer = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  expect(await (await post("asana", "refresh", body)).json()).toEqual({ error: "refused" });
  makerAnswer = () => new Response("down", { status: 503 });
  const down = await post("asana", "refresh", body);
  expect(down.status).toBe(502);
  expect(await down.json()).toEqual({ error: "upstream" });
  makerAnswer = () => Response.json({ token_type: "bearer" });
  expect((await post("asana", "refresh", body)).status).toBe(502);
});

it("no token, code, verifier, state, credential or client secret reaches the logs", async () => {
  const { state, spade, finish } = await started();
  await returnTo("asana", { state, code: "the-code" });
  await finish();
  await post("asana", "refresh", {
    refresh_token: "refresh-secret-0",
    public_key: spade.publicKey,
  });
  await post("asana", "start", {}, grants.machine("user_a"));
  const text = JSON.stringify(logs);
  expect(logs.length).toBeGreaterThan(3);
  expect(text).toContain("user_a");
  for (const secret of [
    "access-secret-1",
    "refresh-secret",
    "the-code",
    spade.verifier,
    state,
    "asana-client-secret",
    grants.cloud("user_a"),
    grants.machine("user_a"),
  ])
    expect(text).not.toContain(secret);
});
