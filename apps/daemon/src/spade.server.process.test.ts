import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { readConfig, startDaemon } from "./index.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";
import { Client } from "./socket-test-support.ts";

const fakeSpade = resolve(import.meta.dirname, "__fixtures__/spade/fake-spade.ts");

const backlog = new WeakMap<Client, ServerMessage[]>();
/** The first message that matches, in arrival order; others stay for later calls. */
async function until<T extends ServerMessage>(
  client: Client,
  match: (message: ServerMessage) => message is T,
): Promise<T> {
  const kept = backlog.get(client) ?? [];
  backlog.set(client, kept);
  const index = kept.findIndex(match);
  if (index !== -1) return kept.splice(index, 1)[0] as T;
  for (;;) {
    const message = await client.next();
    if (match(message)) return message;
    kept.push(message);
  }
}
const status =
  (state: string) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: "spade.status.changed" }> =>
    message.type === "spade.status.changed" && message.status.state === state;
const reply =
  (requestId: string) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: "spade.http.result" }> =>
    message.type === "spade.http.result" && message.requestId === requestId;
const live =
  (requestId: string) =>
  (
    message: ServerMessage,
  ): message is Extract<ServerMessage, { type: "spade.live.frame" | "spade.live.ended" }> =>
    (message.type === "spade.live.frame" || message.type === "spade.live.ended") &&
    message.requestId === requestId;

async function http(
  client: Client,
  requestId: string,
  method: "GET" | "POST",
  path: string,
  body?: string,
) {
  client.send({ type: "spade.http", requestId, method, path, ...(body ? { body } : {}) });
  const { result } = await until(client, reply(requestId));
  if (result.kind !== "response") throw new Error(`Spade request failed: ${result.message}`);
  return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown> };
}
async function mcpStatus(url: string, bearer: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await response.body?.cancel();
  return response.status;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the daemon runs Spade while it is enabled, forwards requests and live streams, restarts a crash and stops it", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-spade-host-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "ace");
  const binary = join(root, "spade-server");
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeSpade}"\n`);
  await chmod(binary, 0o755);
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    spade: {
      env: { PATH: process.env.PATH, HOME: home, ACE_SPADE_BIN: binary },
      backoff: { baseMs: 100, maxMs: 1000, healthyMs: 60_000 },
    },
  });
  onTestFinished(() => daemon.close());
  const token = await readFile(daemon.tokenPath, "utf8");
  const client = new Client(daemon.url);
  onTestFinished(() => client.close());
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });

  client.send({ type: "spade.status", requestId: "s1" });
  const first = await until(
    client,
    (m): m is Extract<ServerMessage, { type: "spade.status.result" }> =>
      m.type === "spade.status.result",
  );
  expect(first.status.state).toBe("off");

  // Off by default; turning the setting on starts Spade.
  const enable = (value: boolean, requestId: string) =>
    client.send({
      type: "settings.set",
      requestId,
      key: "spade.enabled",
      value,
      layer: { kind: "global" },
    });
  enable(true, "on");
  await until(client, status("starting"));
  const ready = await until(client, status("ready"));
  expect(ready.status.version).toBe("0.1.0-fake");

  // Spade got the daemon's address, the local token and an MCP lease that works.
  const env = (await http(client, "h1", "GET", "/v1/env")).body;
  expect(env).toMatchObject({ aceUrl: daemon.url, aceToken: token });
  const mcpUrl = String(env.mcpUrl);
  const firstLease = String(env.mcpToken);
  expect(await mcpStatus(mcpUrl, firstLease)).not.toBe(401);

  // Bodies pass through untouched, both ways.
  const created = await http(client, "h2", "POST", "/v1/conversations", '{"text":"hi"}');
  expect(created).toEqual({ status: 201, body: { id: "c1", received: '{"text":"hi"}' } });

  // Live: the first stored event, then a delta pushed while the stream is open.
  client.send({
    type: "spade.live.subscribe",
    requestId: "l1",
    path: "/v1/conversations/c1/live?after=4",
  });
  expect(await until(client, live("l1"))).toMatchObject({
    type: "spade.live.frame",
    event: "stored",
    data: '{"seq":5}',
  });
  await http(client, "h3", "POST", "/v1/conversations/c1/messages", "more");
  expect(await until(client, live("l1"))).toMatchObject({
    type: "spade.live.frame",
    event: "delta",
    data: '{"text":"more"}',
  });

  // A crash is reported, the stream ends, and Spade comes back with a new lease.
  await http(client, "h4", "POST", "/v1/crash");
  const ended = await until(client, live("l1"));
  expect(ended.type).toBe("spade.live.ended");
  const failed = await until(client, status("failed"));
  expect(failed.status.reason).toBe("Spade exited with code 1.");
  await until(client, status("ready"));
  expect(await mcpStatus(mcpUrl, firstLease)).toBe(401);
  const restarted = (await http(client, "h5", "GET", "/v1/env")).body;
  expect(restarted.pid).not.toBe(env.pid);

  // Turning it off stops Spade: its stream ends as restarted, its lease is revoked.
  client.send({
    type: "spade.live.subscribe",
    requestId: "l2",
    path: "/v1/conversations/c1/live?after=0",
  });
  await until(client, live("l2"));
  enable(false, "off");
  expect(await until(client, live("l2"))).toMatchObject({
    type: "spade.live.ended",
    reason: "restarted",
  });
  await until(client, status("off"));
  expect(alive(Number(restarted.pid))).toBe(false);
  expect(await mcpStatus(mcpUrl, String(restarted.mcpToken))).toBe(401);
  client.send({ type: "spade.http", requestId: "h6", method: "GET", path: "/v1/env" });
  expect((await until(client, reply("h6"))).result).toMatchObject({
    kind: "error",
    code: "unavailable",
  });
}, 30_000);
