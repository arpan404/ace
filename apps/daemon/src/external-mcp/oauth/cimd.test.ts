import { expect, test } from "vitest";
import {
  ClientMetadata,
  metadataFetchesAtOnce,
  metadataMaxBytes,
  metadataUrl,
  type MetadataFetch,
} from "./cimd.ts";
import { publicMetadataFetch } from "./cimd-fetch.ts";

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

test("only a few documents are fetched at once, across clients", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const fetched: string[] = [];
  const clients = new ClientMetadata({
    now: () => 0,
    fetch: async (url) => {
      fetched.push(url.href);
      await held;
      return { status: 404, headers: new Headers(), body: new Uint8Array() };
    },
  });
  const ids = Array.from(
    { length: metadataFetchesAtOnce + 1 },
    (_, i) => `https://c${i}.example/m.json`,
  );
  const results = ids.map((clientId) => clients.resolve(clientId));
  expect(await results.at(-1)).toMatchObject({ problem: expect.stringContaining("busy") });
  expect(fetched).toHaveLength(metadataFetchesAtOnce);
  release();
  await Promise.all(results);
  // Once they finish, the next sign-in fetches again.
  void clients.resolve(ids.at(-1) ?? "");
  expect(fetched).toHaveLength(metadataFetchesAtOnce + 1);
});

test("the daemon's own fetch gives up on a slow lookup at the deadline and never reaches private hosts", async () => {
  const url = new URL("https://slow.example/m.json");
  const stuck = publicMetadataFetch(() => new Promise(() => {}));
  await expect(stuck(url, AbortSignal.timeout(20))).rejects.toBeDefined();
  const local = publicMetadataFetch(async () => ["93.184.215.14", "10.0.0.5"]);
  await expect(local(url, AbortSignal.timeout(1000))).rejects.toThrow("not public");
  const mapped = publicMetadataFetch(async () => ["64:ff9b::7f00:1"]);
  await expect(mapped(url, AbortSignal.timeout(1000))).rejects.toThrow("not public");
});
