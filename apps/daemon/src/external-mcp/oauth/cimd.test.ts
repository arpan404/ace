import { expect, test } from "vitest";
import { ClientMetadata, metadataMaxBytes, metadataUrl, type MetadataFetch } from "./cimd.ts";

const id = "https://client.example/oauth/metadata.json";
const document = {
  client_id: id,
  client_name: "Example Assistant",
  redirect_uris: ["https://client.example/callback", "javascript:alert(1)"],
  token_endpoint_auth_method: "none",
};
function served(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const fetched: string[] = [];
  const fetch: MetadataFetch = async (url) => {
    fetched.push(url.href);
    return {
      status: init.status ?? 200,
      headers: new Headers(init.headers),
      body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  const clock = { now: 0 };
  return { fetched, clock, clients: new ClientMetadata({ fetch, now: () => clock.now }) };
}

test("a metadata document names the client, its domain and its usable redirects", async () => {
  const f = served(document);
  expect(await f.clients.resolve(id)).toEqual({
    kind: "cimd",
    clientId: id,
    name: "Example Assistant",
    domain: "client.example",
    redirectUris: ["https://client.example/callback"],
  });
});

test("only https client_ids on port 443 with a path are fetched", async () => {
  const f = served(document);
  for (const bad of [
    "http://client.example/meta.json",
    "https://client.example",
    "https://client.example/",
    "https://client.example:8443/meta.json",
    "https://client.example/meta.json#x",
    "https://client.example/meta.json?x=1",
    "https://u:p@client.example/meta.json",
    "https://client.example/a/../meta.json",
    "client-123",
  ]) {
    expect(metadataUrl(bad), bad).toBeUndefined();
    expect(await f.clients.resolve(bad)).toMatchObject({ problem: expect.any(String) });
  }
  expect(f.fetched).toEqual([]);
});

test("a document is refused when it names another client_id, lacks fields or isn't JSON", async () => {
  const cases: unknown[] = [
    { ...document, client_id: "https://client.example/other.json" },
    { ...document, client_name: undefined },
    { ...document, redirect_uris: ["javascript:alert(1)"] },
    { ...document, token_endpoint_auth_method: "private_key_jwt" },
    "not json",
  ];
  for (const body of cases)
    expect(await served(body).clients.resolve(id)).toMatchObject({ problem: expect.any(String) });
  expect(await served(document, { status: 302 }).clients.resolve(id)).toMatchObject({
    problem: expect.stringContaining("302"),
  });
});

test("a document over the size cap is refused", async () => {
  const f = served({ ...document, padding: "x".repeat(metadataMaxBytes) });
  expect(await f.clients.resolve(id)).toMatchObject({ problem: expect.stringContaining("large") });
});

test("a fetched document is cached as its headers allow", async () => {
  const f = served(document, { headers: { "cache-control": "max-age=60" } });
  await f.clients.resolve(id);
  await f.clients.resolve(id);
  expect(f.fetched).toHaveLength(1);
  f.clock.now += 60_000;
  await f.clients.resolve(id);
  expect(f.fetched).toHaveLength(2);
  const uncached = served(document, { headers: { "cache-control": "no-store" } });
  await uncached.clients.resolve(id);
  await uncached.clients.resolve(id);
  expect(uncached.fetched).toHaveLength(2);
});

test("a failed fetch is a problem the page can show, not a throw", async () => {
  const clients = new ClientMetadata({
    fetch: async () => {
      throw new Error("refused: private address");
    },
    now: () => 0,
  });
  expect(await clients.resolve(id)).toEqual({
    problem: "Couldn't fetch client.example's client metadata.",
  });
});
