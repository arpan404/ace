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
  const http = relayHttp({ settings: () => store, handler: () => undefined });
  expect(await http.enabled()).toBe(false);
  await store.set("remote.relayMcp", true, { kind: "global" });
  expect(await http.enabled()).toBe(true);
  await store.set("remote.relayMcp", false, { kind: "global" });
  expect(await http.enabled()).toBe(false);
  expect(await relayHttp({ settings: () => undefined, handler: () => undefined }).enabled()).toBe(
    false,
  );
});

test("with no outside MCP server yet, every forwarded request is answered 404", async () => {
  const http = relayHttp({ settings: () => undefined, handler: () => undefined });
  const response = await http.handle(request(), new AbortController().signal, forwarded);
  expect(response.status).toBe(404);
});

test("once the outside MCP server's handler is set, forwarded requests reach it", async () => {
  let handler: RelayHttpHandler | undefined;
  const http = relayHttp({ settings: () => undefined, handler: () => handler });
  expect((await http.handle(request(), new AbortController().signal, forwarded)).status).toBe(404);
  handler = async (incoming, _signal, where) =>
    new Response(`${incoming.method} ${incoming.url} ${where.prefix}`);
  const response = await http.handle(request(), new AbortController().signal, forwarded);
  expect(await response.text()).toBe("POST https://relay.example/m/HOST/mcp /m/HOST");
});
