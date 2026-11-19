import { SettingsService } from "@ace/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { relayHttp, type RelayHttpHandler } from "./relay-http.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function settings() {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-relay-http-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  return new SettingsService({ dataDir });
}

const forwarded = { origin: "https://relay.example", prefix: "/m/HOST" };
const request = () => new Request("https://relay.example/m/HOST/mcp", { method: "POST" });

test("the relay path stays off until remote.relayMcp is turned on, read on every request", async () => {
  const store = await settings();
  const http = relayHttp({
    settings: () => store,
    handler: () => undefined,
    webhooks: () => undefined,
  });
  expect(await http.enabled()).toBe(false);
  await store.set("remote.relayMcp", true, { kind: "global" });
  expect(await http.enabled()).toBe(true);
  await store.set("remote.relayMcp", false, { kind: "global" });
  expect(await http.enabled()).toBe(false);
  expect(
    await relayHttp({
      settings: () => undefined,
      handler: () => undefined,
      webhooks: () => undefined,
    }).enabled(),
  ).toBe(false);
});

test("with no outside MCP server yet, every forwarded request is answered 404", async () => {
  const http = relayHttp({
    settings: () => undefined,
    handler: () => undefined,
    webhooks: () => undefined,
  });
  const response = await http.handle(request(), new AbortController().signal, forwarded);
  expect(response.status).toBe(404);
});

test("once the outside MCP server's handler is set, forwarded requests reach it", async () => {
  let handler: RelayHttpHandler | undefined;
  const store = await settings();
  await store.set("remote.relayMcp", true, { kind: "global" });
  const http = relayHttp({
    settings: () => store,
    handler: () => handler,
    webhooks: () => undefined,
  });
  expect((await http.handle(request(), new AbortController().signal, forwarded)).status).toBe(404);
  handler = async (incoming, _signal, where) =>
    new Response(`${incoming.method} ${incoming.url} ${where.prefix}`);
  const response = await http.handle(request(), new AbortController().signal, forwarded);
  expect(await response.text()).toBe("POST https://relay.example/m/HOST/mcp /m/HOST");
});

const echo =
  (name: string): RelayHttpHandler =>
  async (incoming) =>
    new Response(`${name} ${new URL(incoming.url).pathname}`);
const at = (path: string) => new Request(`https://relay.example/m/HOST${path}`, { method: "POST" });
const answer = async (http: ReturnType<typeof relayHttp>, path: string) => {
  const response = await http.handle(at(path), new AbortController().signal, forwarded);
  return `${response.status} ${response.status === 200 ? await response.text() : ""}`.trim();
};

test("webhooks alone open the relay path to /hooks/ and nothing else", async () => {
  const store = await settings();
  const http = relayHttp({
    settings: () => store,
    handler: () => echo("mcp"),
    webhooks: () => ({ enabled: () => true, relay: echo("hooks") }),
  });
  expect(await http.enabled()).toBe(true);
  expect(await answer(http, "/hooks/abc")).toBe("200 hooks /m/HOST/hooks/abc");
  expect(await answer(http, "/mcp")).toBe("404");
  expect(await answer(http, "/.well-known/oauth-protected-resource")).toBe("404");
});

test("outside MCP alone never reaches the webhook handler", async () => {
  const store = await settings();
  await store.set("remote.relayMcp", true, { kind: "global" });
  const http = relayHttp({
    settings: () => store,
    handler: () => echo("mcp"),
    webhooks: () => ({ enabled: () => false, relay: echo("hooks") }),
  });
  expect(await answer(http, "/hooks/abc")).toBe("404");
  expect(await answer(http, "/mcp")).toBe("200 mcp /m/HOST/mcp");
});
