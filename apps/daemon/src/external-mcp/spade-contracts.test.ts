import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { inboxProof } from "../machines/target-spade.ts";
import { canonicalJson, cardKey } from "./card-signature.ts";
import { draft, grantFixture } from "./grant-test-support.ts";
import { outsideBase, type OutsideBase } from "./oauth/base.ts";
import { spadeContracts } from "./spade-contracts.ts";

const aceToken = "a1".repeat(32);
const spadeToken = "spade-test-token";

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Spade's API as the daemon reaches it, on a real local port: answers each path as given. */
async function fakeSpade(answers: Record<string, { status: number; body?: unknown }>) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    if (request.headers.authorization !== `Bearer ${spadeToken}`) {
      response.writeHead(401).end();
      return;
    }
    const answer = answers[request.url ?? ""] ?? { status: 404, body: { error: "no" } };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { received, connection: { host: "127.0.0.1", port, token: spadeToken } };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const base: OutsideBase = outsideBase("relay", "https://relay.example/m/host-1");
const local: OutsideBase = outsideBase("local", "http://127.0.0.1:7000");
const machineKey = cardKey(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);

async function world(answers: Record<string, { status: number; body?: unknown }> = {}) {
  const spade = await fakeSpade(answers);
  const grants = grantFixture(Date.now());
  const serve = spadeContracts({
    verify: (token, resource) => grants.tokens.verify(token, resource),
    touch: (grant) => grants.grants.touch(grant),
    spade: () => spade.connection,
    key: () => aceToken,
    cardKey: () => machineKey,
    now: () => grants.clock.now,
  });
  /** An access token for a grant with `scopes`, issued at `base`. */
  const token = (scopes: Parameters<typeof draft>[0] = {}) => {
    const grant = grants.grants.create(draft(scopes));
    return { grant, token: grants.tokens.issuePair(grant, `${base.url}/mcp`).accessToken };
  };
  const request = (
    at: OutsideBase,
    path: string,
    init: { method?: string; bearer?: string; body?: string; headers?: Record<string, string> },
  ) =>
    serve(
      new Request(`${at.url}${path}`, {
        method: init.method ?? "POST",
        headers: {
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
          "content-type": "application/json",
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      at,
      path,
    );
  return { spade, grants, token, request };
}

const toolsCall = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });

test("a grant without spade-contracts is refused with insufficient_scope and nothing reaches Spade", async () => {
  const w = await world();
  const { token } = w.token({ scopes: ["threads:read", "threads:start"] });
  for (const path of ["/spade/mcp", "/spade/a2a"]) {
    const refused = await w.request(base, path, { bearer: token, body: toolsCall });
    expect(refused.status).toBe(403);
    const challenge = refused.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="spade-contracts"');
    expect(challenge).toContain(
      `resource_metadata="https://relay.example/.well-known/oauth-protected-resource/m/host-1${path}"`,
    );
  }
  const card = await w.request(base, "/.well-known/agent-card.json", {
    method: "GET",
    bearer: token,
  });
  expect(card.status).toBe(403);
  expect(w.spade.received).toEqual([]);
});

test("no token, a token ace never issued, Spade's own grant or a revoked one gets a 401 and reaches nothing", async () => {
  const w = await world();
  const spades = w.token({ clientKind: "spade", scopes: ["threads:read", "spade-contracts"] });
  const revoked = w.token({ scopes: ["threads:read", "spade-contracts"] });
  w.grants.grants.revoke(revoked.grant.id);
  for (const bearer of [undefined, "forged-token", spades.token, revoked.token]) {
    const refused = await w.request(base, "/spade/mcp", {
      ...(bearer ? { bearer } : {}),
      body: toolsCall,
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://relay.example/.well-known/oauth-protected-resource/m/host-1/spade/mcp"',
    );
  }
  // A token issued at another base doesn't work here.
  const elsewhere = w.grants.grants.create(draft({ scopes: ["threads:read", "spade-contracts"] }));
  const theirs = w.grants.tokens.issuePair(elsewhere, "https://other.example/mcp").accessToken;
  expect((await w.request(base, "/spade/a2a", { bearer: theirs, body: toolsCall })).status).toBe(
    401,
  );
  expect(w.spade.received).toEqual([]);
});

test("a call goes to Spade stamped as the caller's grant and signed by ace, and Spade's answer comes back as it was", async () => {
  const answer = { jsonrpc: "2.0", id: 1, result: { structuredContent: { fare: 182 } } };
  const w = await world({ "/v1/outside/mcp": { status: 200, body: answer } });
  const { grant, token } = w.token({
    name: "Claude Code ✓",
    scopes: ["threads:read", "spade-contracts"],
  });
  const answered = await w.request(base, "/spade/mcp", {
    bearer: token,
    body: toolsCall,
    headers: {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "x-other": "kept out",
    },
  });
  expect(answered.status).toBe(200);
  expect(await answered.json()).toEqual(answer);

  const [sent, ...more] = w.spade.received;
  expect(more).toEqual([]);
  if (!sent) throw new Error("nothing reached Spade");
  expect(sent.method).toBe("POST");
  expect(sent.body.toString()).toBe(toolsCall);
  expect(sent.headers["x-ace-from-host"]).toBe(`ace:outside:${grant.id}`);
  const name = String(sent.headers["x-ace-from-name"]);
  expect(decodeURIComponent(name)).toBe("Claude Code ✓");
  const time = Number(sent.headers["x-ace-inbox-time"]);
  expect(sent.headers["x-ace-inbox-proof"]).toBe(
    inboxProof(aceToken, time, `ace:outside:${grant.id}`, name, sent.body),
  );
  expect(sent.headers["mcp-protocol-version"]).toBe("2026-07-28");
  expect(sent.headers["mcp-method"]).toBe("tools/call");
  expect(sent.headers["x-other"]).toBeUndefined();
});

test("a pasted CLI token with spade-contracts reaches Spade's A2A endpoint on this computer", async () => {
  const w = await world({
    "/v1/outside/a2a": { status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } },
  });
  const grant = w.grants.grants.create(
    draft({ clientKind: "cli", scopes: ["threads:read", "spade-contracts"] }),
  );
  const bearer = w.grants.tokens.issueBearer(grant);
  const answered = await w.request(local, "/spade/a2a", {
    bearer,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "t" } }),
    headers: { "a2a-version": "1.0" },
  });
  expect(answered.status).toBe(200);
  expect(w.spade.received.map((r) => [r.path, r.headers["a2a-version"]])).toEqual([
    ["/v1/outside/a2a", "1.0"],
  ]);
  // Only POST: no server stream to open and no session to end.
  expect((await w.request(local, "/spade/a2a", { method: "GET", bearer })).status).toBe(405);
});

test("the Agent Card is Spade's, addressed here and signed with this machine's key, which verifies it", async () => {
  const fromSpade = {
    name: "Spade",
    description: "Contracts.",
    version: "0.1.0",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      { id: "flight_watcher__cheapest_fare", name: "Fares", description: "Fares.", tags: [] },
    ],
  };
  const w = await world({ "/v1/outside/card": { status: 200, body: fromSpade } });
  const { token } = w.token({ scopes: ["threads:read", "spade-contracts"] });
  const answered = await w.request(base, "/.well-known/agent-card.json", {
    method: "GET",
    bearer: token,
  });
  expect(answered.status).toBe(200);
  expect(answered.headers.get("etag")).toMatch(/^"[\w-]+"$/);
  const card = (await answered.json()) as Record<string, unknown>;
  expect(card["supportedInterfaces"]).toEqual([
    {
      url: "https://relay.example/m/host-1/spade/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ]);
  expect(card["skills"]).toEqual(fromSpade.skills);
  // Spade was asked for the card as the caller's grant.
  expect(w.spade.received.map((r) => [r.method, r.path])).toEqual([["GET", "/v1/outside/card"]]);

  // The key is public, at the address the signature names.
  const [signature] = card["signatures"] as { protected: string; signature: string }[];
  const header = JSON.parse(Buffer.from(signature?.protected ?? "", "base64url").toString()) as {
    kid: string;
    jku: string;
  };
  expect(header.jku).toBe("https://relay.example/m/host-1/spade/jwks.json");
  const keys = await w.request(base, "/spade/jwks.json", { method: "GET" });
  expect(keys.status).toBe(200);
  const { keys: published } = (await keys.json()) as {
    keys: { kid: string; kty: string; crv: string; x: string; y: string }[];
  };
  const jwk = published.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error(`no key ${header.kid} in ${JSON.stringify(published)}`);
  const { signatures: _signatures, ...payload } = card;
  const verifies = (body: unknown) =>
    verify(
      "sha256",
      Buffer.from(
        `${signature?.protected}.${Buffer.from(canonicalJson(body)).toString("base64url")}`,
      ),
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature?.signature ?? "", "base64url"),
    );
  expect(verifies(payload)).toBe(true);
  expect(verifies({ ...payload, supportedInterfaces: [] })).toBe(false);
});
