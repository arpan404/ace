import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { readConfig, startDaemon } from "./index.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";
import { Client } from "./socket-test-support.ts";
import { fakeSpadeService } from "./__fixtures__/spade/fake-service.ts";
import { mcpStatus, spadeEnv, until as poll } from "./spade-test-support.ts";

const pollMs = { waiting: 50, ready: 200 };

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
test("the daemon forwards requests and live streams to the Spade service, follows its restarts and lets it go when turned off", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-spade-service-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "ace");
  const service = fakeSpadeService(() => home);
  onTestFinished(() => service.close());
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    spade: { service: service.control, pollMs },
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

  // Off by default; turning the setting on registers Spade's service, which starts it.
  const enable = (value: boolean, requestId: string) =>
    client.send({
      type: "settings.set",
      requestId,
      key: "spade.enabled",
      value,
      layer: { kind: "global" },
    });
  enable(true, "on");
  const ready = await until(client, status("ready"));
  expect(ready.status.version).toBe("0.1.0-fake");
  expect(service.registered()).toBe(true);

  // Spade was handed its grant, which works on the daemon's MCP endpoint.
  const mcpUrl = daemon.mcp?.url ?? "";
  const env = await poll(async () => {
    const seen = await spadeEnv(daemon);
    return seen.grant ? seen : undefined;
  }, "Spade's grant");
  expect(await mcpStatus(mcpUrl, env.grant ?? "")).toBe(200);
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

  // Spade crashes and its service manager starts it again: the stream to the old one ends, and
  // the new one, which lost its grant with its memory, is handed a new one.
  await http(client, "h4", "POST", "/v1/crash");
  const ended = await until(client, live("l1"));
  expect(ended.type).toBe("spade.live.ended");
  const restarted = await poll(async () => {
    if (daemon.spade?.status().state !== "ready") return undefined;
    const seen = await spadeEnv(daemon).catch(() => undefined);
    return seen && seen.pid !== env.pid && seen.grant ? seen : undefined;
  }, "the restarted Spade's grant");
  expect(restarted.grant).not.toBe(env.grant);
  expect(await mcpStatus(mcpUrl, env.grant ?? "")).toBe(401);
  expect(await mcpStatus(mcpUrl, restarted.grant ?? "")).toBe(200);

  // Turning it off: its stream ends, its grant stops working and its service is removed.
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
  await poll(() => !service.registered() && service.pid() === undefined, "Spade's service to go");
  expect(await mcpStatus(mcpUrl, restarted.grant ?? "")).toBe(401);
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
  const service = fakeSpadeService(() => home);
  onTestFinished(() => service.close());
  const daemon = await startDaemon({
    engine: noProviderDiscovery,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    spade: { service: service.control, pollMs },
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
