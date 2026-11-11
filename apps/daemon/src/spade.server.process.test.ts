import { createHash } from "node:crypto";
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
  client.send({
    type: "spade.http",
    requestId,
    method,
    path,
    encoding: "text",
    ...(body ? { body } : {}),
  });
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
  // A setting of ace's own in the daemon's environment, which Spade must not inherit.
  process.env.ACE_PROBE_SETTING = "daemon-only";
  onTestFinished(() => {
    delete process.env.ACE_PROBE_SETTING;
  });
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
  // None of ace's own settings reach Spade, even those the daemon itself runs with.
  expect(env.aceKeys).toEqual([]);
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
  client.send({
    type: "spade.http",
    requestId: "h6",
    method: "GET",
    path: "/v1/env",
    encoding: "text",
  });
  expect((await until(client, reply("h6"))).result).toMatchObject({
    kind: "error",
    code: "unavailable",
  });
}, 30_000);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The bytes the fake answers `GET /v1/images/{n}` with. */
const imageBytes = (size: number) =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 7) % 256));

test("spade.http carries images back as base64 and streams a message with images to Spade in parts", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-spade-bodies-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "ace");
  const binary = join(root, "spade-server");
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeSpade}"\n`);
  await chmod(binary, 0o755);
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    spade: { env: { PATH: process.env.PATH, HOME: home, ACE_SPADE_BIN: binary } },
  });
  onTestFinished(() => daemon.close());
  const token = await readFile(daemon.tokenPath, "utf8");
  const client = new Client(daemon.url);
  onTestFinished(() => client.close());
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
  client.send({ type: "spade.status", requestId: "s1" });
  client.send({
    type: "settings.set",
    requestId: "on",
    key: "spade.enabled",
    value: true,
    layer: { kind: "global" },
  });
  await until(client, status("ready"));
  const result = async (requestId: string) => (await until(client, reply(requestId))).result;

  // An image comes back as its bytes, in base64, with Spade's content type.
  const size = 3 * 1024 * 1024;
  client.send({
    type: "spade.http",
    requestId: "image",
    method: "GET",
    path: `/v1/images/${size}`,
    encoding: "text",
  });
  const image = await result("image");
  if (image.kind !== "response") throw new Error(image.message);
  expect(image).toMatchObject({ status: 200, encoding: "base64", contentType: "image/png" });
  // Longer than one message carries: the rest is read piece by piece.
  const pieceCount = image.parts ?? 1;
  expect(pieceCount).toBeGreaterThan(1);
  const pieces = [image.body];
  for (let index = 1; index < pieceCount; index++) {
    client.send({ type: "spade.http.read", requestId: "image", index });
    const chunk = await until(
      client,
      (m): m is Extract<ServerMessage, { type: "spade.http.chunk" }> =>
        m.type === "spade.http.chunk" && m.requestId === "image" && m.index === index,
    );
    expect(chunk.gone).toBeUndefined();
    pieces.push(chunk.body);
  }
  expect(sha256(Buffer.from(pieces.join(""), "base64"))).toBe(sha256(imageBytes(size)));
  // Read in full, the answer is let go.
  client.send({ type: "spade.http.read", requestId: "image", index: 1 });
  expect(
    await until(
      client,
      (m): m is Extract<ServerMessage, { type: "spade.http.chunk" }> =>
        m.type === "spade.http.chunk" && m.requestId === "image",
    ),
  ).toMatchObject({ gone: true });

  // A message with images (4 MiB of JSON) goes to Spade in parts, as text or as base64 bytes.
  const message = Buffer.from(
    JSON.stringify({ text: "look", images: [{ data: imageBytes(size).toString("base64") }] }),
  );
  const expected = { status: 202, body: { bytes: message.length, sha256: sha256(message) } };
  const upload = async (
    requestId: string,
    text: string,
    encoding: "text" | "base64",
    step: number,
    path = "/v1/conversations/c2/messages",
  ) => {
    const parts = Math.ceil(text.length / step);
    client.send({
      type: "spade.http",
      requestId,
      method: "POST",
      path,
      encoding,
      parts,
    });
    // Parts go only once the daemon says the request is open.
    await until(
      client,
      (m): m is Extract<ServerMessage, { type: "spade.http.open" }> =>
        m.type === "spade.http.open" && m.requestId === requestId,
    );
    for (let index = 0; index < parts; index++)
      client.send({
        type: "spade.http.part",
        requestId,
        index,
        body: text.slice(index * step, (index + 1) * step),
      });
  };
  for (const [requestId, encoding] of [
    ["text-parts", "text"],
    ["base64-parts", "base64"],
  ] as const) {
    await upload(
      requestId,
      encoding === "text" ? message.toString("utf8") : message.toString("base64"),
      encoding,
      // A base64 part holds whole quanta: a multiple of 4 characters.
      encoding === "text" ? 150_000 : 196_608,
    );
    const answer = await result(requestId);
    if (answer.kind !== "response") throw new Error(answer.message);
    expect({ status: answer.status, body: JSON.parse(answer.body) }).toEqual(expected);
  }

  // Any other route keeps the small cap, refused before Spade sees the body.
  await upload("too-big", "x".repeat(600 * 1024), "text", 150_000, "/v1/conversations/c2/stop");
  expect(await result("too-big")).toMatchObject({ kind: "error", code: "too_large" });
}, 30_000);
