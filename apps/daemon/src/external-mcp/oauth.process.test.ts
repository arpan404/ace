import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import type { OutsideAccessDecision } from "@ace/protocol";
import type { MetadataFetch } from "./oauth/cimd.ts";
import { adminWindow, call, listed, rpc, type Fixture } from "./outside-test-support.ts";

// A whole sign-in as an outside client makes it, against one real daemon over local HTTP. The
// client's metadata document is served by the fetch the daemon is given (its real fetch refuses
// this machine's addresses); the person approves through an admin socket.
const clientId = "https://assistant.example/oauth/client.json";
const redirectUri = "http://127.0.0.1:9/callback";
const metadata: MetadataFetch = async (url) => ({
  status: url.href === clientId ? 200 : 404,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(
    JSON.stringify({
      client_id: clientId,
      client_name: "Assistant",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  ),
});
const requestTtlMs = 2_000;

const closers: (() => unknown)[] = [];
let shared: Promise<Fixture> | undefined;
beforeAll(() => {
  shared = daemonFixture(undefined, {
    outsideClients: { fetchClientMetadata: metadata, requestTtlMs },
  });
});
afterAll(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
  await (await shared)?.daemon.close();
});
async function fixture() {
  if (!shared) throw new Error("No daemon");
  const f = await shared;
  const external = f.daemon.externalMcp;
  if (!external) throw new Error("No outside endpoint");
  const admin = await adminWindow(f, closers);
  return { f, external, admin, mcpUrl: external.url, base: new URL(external.url).origin };
}

const Tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  scope: z.string(),
});
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function challengeOf(response: Response): Record<string, string> {
  const header = response.headers.get("www-authenticate") ?? "";
  return Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}
/** Opens /authorize as the browser would, returning the waiting page's URL and match code. */
async function authorize(
  base: string,
  params: { client: string; challenge: string; scope?: string; redirect?: string },
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.client,
    redirect_uri: params.redirect ?? redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: `${base}/mcp`,
    ...(params.scope ? { scope: params.scope } : {}),
  });
  const started = await fetch(`${base}/authorize?${query}`, { redirect: "manual" });
  expect(started.status, await started.clone().text()).toBe(303);
  const wait = started.headers.get("location") ?? "";
  const page = await fetch(wait, { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await page.text();
  const matchCode = /<p class="code">([A-Z0-9]+)<\/p>/.exec(html)?.[1] ?? "";
  return { wait, html, matchCode };
}
/** The person's choice in ace, through the admin socket, for the request showing `matchCode`. */
async function decide(
  setup: Awaited<ReturnType<typeof fixture>>,
  matchCode: string,
  choice: OutsideAccessDecision,
) {
  const request = setup.external.outside.requests
    .current()
    .find((entry) => entry.matchCode === matchCode);
  if (!request) throw new Error("No such sign-in request");
  await setup.admin({ op: "decide", accessRequestId: request.requestId, choice });
  return request;
}
/** The waiting page once decided: the redirect back to the client. */
async function returned(wait: string): Promise<URL> {
  for (let i = 0; i < 100; i++) {
    const page = await fetch(wait, { redirect: "manual" });
    if (page.status === 303) return new URL(page.headers.get("location") ?? "");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The sign-in never ended");
}
async function token(base: string, form: Record<string, string>) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return { status: response.status, body: await response.json() };
}
const approveRead: OutsideAccessDecision = {
  decision: "approve",
  scopes: ["threads:read"],
  projects: "all",
  expiresAt: null,
};

test("a client discovers sign-in from the 401, signs in with its metadata document and calls tools", async () => {
  const setup = await fixture();
  const { base, mcpUrl } = setup;
  const unauthorized = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{}",
  });
  expect(unauthorized.status).toBe(401);
  const resourceMetadata = challengeOf(unauthorized)["resource_metadata"] ?? "";
  expect(resourceMetadata).toBe(`${base}/.well-known/oauth-protected-resource/mcp`);
  const resource = z
    .object({ resource: z.string(), authorization_servers: z.array(z.string()) })
    .parse(await (await fetch(resourceMetadata)).json());
  expect(resource).toMatchObject({ resource: mcpUrl, authorization_servers: [base] });
  const server = z
    .object({ issuer: z.string(), client_id_metadata_document_supported: z.literal(true) })
    .parse(await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json());
  expect(server.issuer).toBe(base);

  const { verifier, challenge } = pkce();
  const page = await authorize(base, { client: clientId, challenge });
  expect(page.html).toContain("Assistant");
  expect(page.html).toContain("assistant.example");
  expect(page.html).toContain("127.0.0.1:9");
  expect(page.html).toContain("an app on this device");
  const shown = await decide(setup, page.matchCode, approveRead);
  // The approver in ace sees where the code goes.
  expect(shown).toMatchObject({ redirectHost: "127.0.0.1:9", redirectKind: "this-device" });
  expect(shown.grantId).toBeUndefined();
  const back = await returned(page.wait);
  expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
  expect(back.searchParams.get("state")).toBe("state-1");
  expect(back.searchParams.get("iss")).toBe(base);
  const code = back.searchParams.get("code") ?? "";

  const exchange = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
  const wrongVerifier = await token(base, {
    ...exchange,
    client_id: clientId,
    code_verifier: pkce().verifier,
    resource: mcpUrl,
  });
  expect(wrongVerifier).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  // The failed attempt used the code up; sign in again for a fresh one.
  const again = await authorize(base, { client: clientId, challenge });
  await decide(setup, again.matchCode, approveRead);
  const fresh = (await returned(again.wait)).searchParams.get("code") ?? "";
  const traded = await token(base, {
    ...exchange,
    code: fresh,
    client_id: clientId,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  expect(traded.status, JSON.stringify(traded.body)).toBe(200);
  const pair = Tokens.parse(traded.body);
  expect(pair.scope).toBe("threads:read");
  expect(await listed({ url: mcpUrl, bearer: pair.access_token })).toContain("ace_thread_read");
  const refreshed = await token(base, {
    grant_type: "refresh_token",
    refresh_token: pair.refresh_token,
    client_id: clientId,
  });
  expect(refreshed.status).toBe(200);
  const next = Tokens.parse(refreshed.body);
  expect(next.refresh_token).not.toBe(pair.refresh_token);
  expect(await listed({ url: mcpUrl, bearer: next.access_token })).toContain("ace_thread_read");
  const grants = await setup.admin({ op: "grants" });
  if (grants.kind !== "grants") throw new Error("No grants");
  expect(grants.grants.find((grant) => grant.clientId === clientId)).toMatchObject({
    clientKind: "cimd",
    domain: "assistant.example",
    name: "Assistant",
  });

  // A code presented again means someone else holds it: what it issued stops working.
  expect(
    await token(base, {
      ...exchange,
      code: fresh,
      client_id: clientId,
      code_verifier: verifier,
      resource: mcpUrl,
    }),
  ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  expect((await rpc({ url: mcpUrl, bearer: next.access_token }, "tools/list")).status).toBe(401);
});

test("a call outside the grant gets 403 insufficient_scope, and signing in again makes a new grant", async () => {
  const setup = await fixture();
  const { base, mcpUrl } = setup;
  const signIn = async (scope: string, scopes: ("threads:read" | "threads:start")[]) => {
    const { verifier, challenge } = pkce();
    const page = await authorize(base, { client: clientId, challenge, scope });
    const request = await decide(setup, page.matchCode, {
      ...approveRead,
      scopes,
    });
    const code = (await returned(page.wait)).searchParams.get("code") ?? "";
    const traded = await token(base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: mcpUrl,
    });
    return { request, pair: Tokens.parse(traded.body) };
  };
  const first = await signIn("threads:read", ["threads:read"]);
  const lease = { url: mcpUrl, bearer: first.pair.access_token };
  const refused = await call(lease, "ace_thread_run", {
    project: setup.f.workspace,
    provider: "codex",
    text: "x",
    idempotencyKey: "k",
  });
  expect(refused.status).toBe(403);
  const header = refused.headers.get("www-authenticate") ?? "";
  expect(header).toContain('error="insufficient_scope"');
  expect(header).toContain('scope="threads:start"');
  expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const liveGrants = async () => {
    const all = await setup.admin({ op: "grants" });
    if (all.kind !== "grants") throw new Error("No grants");
    return all.grants.filter((grant) => grant.clientId === clientId && grant.revokedAt === null);
  };
  const before = await liveGrants();
  const stepped = await signIn("threads:read threads:start", ["threads:read", "threads:start"]);
  expect(stepped.request.grantId).toBeUndefined();
  expect(stepped.pair.scope).toBe("threads:read threads:start");
  expect(await listed({ url: mcpUrl, bearer: stepped.pair.access_token })).toContain(
    "ace_thread_run",
  );
  // The first grant is as the person approved it; the new one is its own row.
  expect(await liveGrants()).toHaveLength(before.length + 1);
  expect(
    (
      await call(lease, "ace_thread_run", {
        project: setup.f.workspace,
        provider: "codex",
        text: "x",
        idempotencyKey: "k2",
      })
    ).status,
  ).toBe(403);
});

test("a DCR client signs in unverified; denial and expiry return access_denied with iss", async () => {
  const setup = await fixture();
  const { base, mcpUrl } = setup;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Script", redirect_uris: [redirectUri] }),
  });
  expect(registered.status).toBe(201);
  const dcr = z.object({ client_id: z.string() }).parse(await registered.json()).client_id;

  const denied = await authorize(base, { client: dcr, challenge: pkce().challenge });
  expect(denied.html).toContain("Unverified client");
  await decide(setup, denied.matchCode, { decision: "deny" });
  const deniedBack = await returned(denied.wait);
  expect(deniedBack.searchParams.get("error")).toBe("access_denied");
  expect(deniedBack.searchParams.get("iss")).toBe(base);
  expect(deniedBack.searchParams.get("state")).toBe("state-1");

  const ignored = await authorize(base, { client: dcr, challenge: pkce().challenge });
  const expired = await returned(ignored.wait);
  expect(expired.searchParams.get("error")).toBe("access_denied");
  expect(expired.searchParams.get("iss")).toBe(base);

  const { verifier, challenge } = pkce();
  const page = await authorize(base, { client: dcr, challenge });
  await decide(setup, page.matchCode, approveRead);
  const code = (await returned(page.wait)).searchParams.get("code") ?? "";
  const traded = await token(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: dcr,
    code_verifier: verifier,
    resource: mcpUrl,
  });
  const pair = Tokens.parse(traded.body);
  expect(await listed({ url: mcpUrl, bearer: pair.access_token })).toContain("ace_thread_read");
  const grants = await setup.admin({ op: "grants" });
  if (grants.kind !== "grants") throw new Error("No grants");
  expect(grants.grants.find((grant) => grant.clientId === dcr)).toMatchObject({
    clientKind: "dcr",
    domain: null,
  });
});

test("a redirect the client didn't register is never followed", async () => {
  const setup = await fixture();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://attacker.example/cb",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource: setup.mcpUrl,
  });
  const response = await fetch(`${setup.base}/authorize?${query}`, { redirect: "manual" });
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
});

test("a token works only at the URL it was issued for, and the relay path serves its own", async () => {
  const setup = await fixture();
  const { base, mcpUrl, external } = setup;
  const { verifier, challenge } = pkce();
  const page = await authorize(base, { client: clientId, challenge });
  await decide(setup, page.matchCode, approveRead);
  const code = (await returned(page.wait)).searchParams.get("code") ?? "";
  const pair = Tokens.parse(
    (
      await token(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: mcpUrl,
      })
    ).body,
  );
  expect(await listed({ url: mcpUrl, bearer: pair.access_token })).toContain("ace_thread_read");
  // The same listener under another name is another resource.
  const port = new URL(mcpUrl).port;
  const other = await rpc(
    { url: `http://localhost:${port}/mcp`, bearer: pair.access_token },
    "tools/list",
  );
  expect(other.status).toBe(401);

  // ace's relay hands requests in at its own base; the loopback token is refused there.
  const forwarded = { origin: "https://relay.example", prefix: "/m/host-1" };
  const relayed = (path: string, init?: RequestInit) =>
    external.relay(
      new Request(`${forwarded.origin}${forwarded.prefix}${path}`, init),
      new AbortController().signal,
      forwarded,
    );
  const described = z
    .object({ resource: z.string() })
    .parse(await (await relayed("/.well-known/oauth-protected-resource/mcp")).json());
  expect(described.resource).toBe("https://relay.example/m/host-1/mcp");
  const atRelay = await relayed("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${pair.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: "{}",
  });
  expect(atRelay.status).toBe(401);
  expect(challengeOf(atRelay)["resource_metadata"]).toBe(
    "https://relay.example/.well-known/oauth-protected-resource/m/host-1/mcp",
  );
  // A refresh at another base is refused and the pair keeps working where it belongs.
  const elsewhere = await relayed("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: clientId,
    }),
  });
  expect(elsewhere.status).toBe(400);
  expect(await listed({ url: mcpUrl, bearer: pair.access_token })).toContain("ace_thread_read");
});

test("endpoints name every way in, and the person's own URL is served by its Host", async () => {
  const setup = await fixture();
  const before = await setup.admin({ op: "endpoints" });
  if (before.kind !== "endpoints") throw new Error("No endpoints");
  expect(before.endpoints).toEqual([
    { path: "local", url: setup.mcpUrl, on: true },
    { path: "tailscale", url: null, on: false },
    { path: "relay", url: null, on: false },
    { path: "custom", url: null, on: false },
  ]);
  await setup.f.daemon.settings.set("remote.mcpPublicUrl", "https://ace.example.com", {
    kind: "global",
  });
  await setup.f.daemon.settings.set("remote.relayMcp", true, { kind: "global" });
  let after = before.endpoints;
  for (let i = 0; i < 100 && after[3]?.on !== true; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const read = await setup.admin({ op: "endpoints" });
    if (read.kind === "endpoints") after = read.endpoints;
  }
  expect(after[3]).toEqual({ path: "custom", url: "https://ace.example.com/mcp", on: true });
  // On, but this machine isn't registered on ace's relay.
  expect(after[2]).toMatchObject({
    path: "relay",
    url: null,
    on: true,
    problem: expect.any(String),
  });
  const port = Number(new URL(setup.mcpUrl).port);
  const viaProxy = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/.well-known/oauth-protected-resource/mcp",
        headers: { host: "ace.example.com" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  expect(viaProxy.status).toBe(200);
  expect(JSON.parse(viaProxy.body)).toMatchObject({ resource: "https://ace.example.com/mcp" });
});
