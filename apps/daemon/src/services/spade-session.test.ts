import { createServer } from "node:http";
import { expect, test } from "vitest";
import { DeviceId, type DeviceScope, type ServerMessage, SpadeClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { SpadeLink } from "../spade/link.ts";
import { createSpadeSession } from "./spade-session.ts";

/** A session for a device holding `scopes`, with Spade off (turned off, no service). */
function session(scopes: readonly DeviceScope[]) {
  const sent: ServerMessage[] = [];
  const spade = new SpadeLink({
    dataDir: "/ace/spade",
    runtime: {
      readText: async () => undefined,
      health: async () => undefined,
      alive: () => false,
      nonce: () => "0".repeat(32),
      serviceState: async () => "absent",
      watch: () => () => {},
      now: () => 0,
      after: () => () => {},
    },
  });
  const service = createSpadeSession({
    options: { spade },
    authorize: (scope) => scopes.includes(scope),
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
  });
  const handle = async (message: z.input<typeof SpadeClientMessage>) => {
    await service.handle?.(SpadeClientMessage.parse(message), DeviceId.parse("device"));
    return sent.at(-1);
  };
  let revocations = 0;
  spade.setRevoker(async () => {
    revocations++;
    return true;
  });
  return { handle, sent, spade, revocations: () => revocations };
}

test("while Spade is hidden the daemon says so and refuses every request with hidden", async () => {
  const { handle, spade } = session(["read", "operate"]);
  spade.setHidden(true);
  expect(await handle({ type: "spade.status", requestId: "s" })).toMatchObject({
    status: { state: "off", hidden: true },
  });
  expect(
    await handle({ type: "spade.http", requestId: "h", method: "GET", path: "/v1/conversations" }),
  ).toMatchObject({ result: { kind: "error", code: "hidden" } });
  expect(
    await handle({ type: "spade.live.subscribe", requestId: "l", path: "/v1/live" }),
  ).toMatchObject({ type: "spade.live.ended", reason: "hidden" });
  spade.setHidden(false);
  expect(
    await handle({ type: "spade.http", requestId: "h2", method: "GET", path: "/v1/conversations" }),
  ).toMatchObject({ result: { kind: "error", code: "unavailable" } });
});

test("only an administrator can revoke Spade's grant", async () => {
  for (const [scopes, revoked] of [
    [["read", "operate"], false],
    [["read", "operate", "admin"], true],
  ] as const) {
    const { handle, revocations } = session(scopes);
    expect(await handle({ type: "spade.grant.revoke", requestId: "r" })).toEqual({
      type: "spade.grant.revoke.result",
      requestId: "r",
      revoked,
    });
    expect(revocations()).toBe(revoked ? 1 : 0);
  }
});

test("a read-only device can read Spade but not change anything", async () => {
  const { handle } = session(["read"]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    expect(
      await handle({ type: "spade.http", requestId: method, method, path: "/v1/conversations" }),
    ).toMatchObject({ requestId: method, result: { kind: "error", code: "forbidden" } });
  // Allowed through the scope check, then refused only because Spade is off.
  expect(
    await handle({
      type: "spade.http",
      requestId: "get",
      method: "GET",
      path: "/v1/conversations",
    }),
  ).toMatchObject({ result: { kind: "error", code: "unavailable" } });
});

test("a device without the read scope gets nothing from Spade", async () => {
  const { handle } = session([]);
  expect(
    await handle({ type: "spade.http", requestId: "r", method: "GET", path: "/v1/conversations" }),
  ).toMatchObject({ result: { kind: "error", code: "forbidden" } });
  expect(
    await handle({
      type: "spade.live.subscribe",
      requestId: "l",
      path: "/v1/conversations/c/live",
    }),
  ).toEqual({ type: "spade.live.ended", requestId: "l", reason: "forbidden" });
  expect(await handle({ type: "spade.status", requestId: "s" })).toMatchObject({
    type: "spade.status.result",
    status: { state: "off", reason: "This device can't see Spade." },
  });
});

test("paths outside Spade's API are refused before anything is forwarded", async () => {
  const { handle } = session(["read", "operate"]);
  for (const path of ["/health", "/v1/../health", "/v1/%2e%2e/health", "/v2/x"])
    expect(
      await handle({ type: "spade.http", requestId: path, method: "GET", path }),
    ).toMatchObject({
      result: { kind: "error", code: "invalid_path" },
    });
  expect(
    await handle({ type: "spade.live.subscribe", requestId: "l", path: "/v1/conversations" }),
  ).toEqual({ type: "spade.live.ended", requestId: "l", reason: "invalid_path" });
});

test("Spade's inbox can't be reached through spade.http, only from other machines", async () => {
  const { handle } = session(["read", "operate"]);
  for (const path of ["/v1/inbox", "/v1/inbox/", "/v1/Inbox?x=1", "/v1/inbo%78", "/v1/inbox/a"])
    expect(
      await handle({ type: "spade.http", requestId: path, method: "POST", path, body: "{}" }),
    ).toMatchObject({ result: { kind: "error", code: "invalid_path" } });
  // Another route goes past the path check and is refused only because Spade is off.
  expect(
    await handle({ type: "spade.http", requestId: "c", method: "GET", path: "/v1/inboxes" }),
  ).toMatchObject({ result: { kind: "error", code: "unavailable" } });
});

test("while Spade is off, requests and streams say it is unavailable", async () => {
  const { handle } = session(["read", "operate"]);
  expect(
    await handle({
      type: "spade.http",
      requestId: "p",
      method: "POST",
      path: "/v1/conversations",
      body: "{}",
    }),
  ).toMatchObject({
    result: { kind: "error", code: "unavailable", message: "Spade is off on this machine." },
  });
  expect(
    await handle({
      type: "spade.live.subscribe",
      requestId: "l",
      path: "/v1/conversations/c/live?after=0",
    }),
  ).toEqual({ type: "spade.live.ended", requestId: "l", reason: "unavailable" });
  expect(await handle({ type: "spade.status", requestId: "s" })).toEqual({
    type: "spade.status.result",
    requestId: "s",
    status: { state: "off" },
  });
});

test("a Spade that is slow to answer never holds up the connection's next message", async () => {
  // A Spade that takes requests and never answers them.
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port: address.port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
  });
  const device = DeviceId.parse("device");
  const handled = await Promise.race([
    Promise.resolve(
      service.handle?.(
        SpadeClientMessage.parse({
          type: "spade.http",
          requestId: "slow",
          method: "GET",
          path: "/v1/conversations",
        }),
        device,
      ),
    ).then(() => "handled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
  ]);
  expect(handled).toBe("handled");
  await service.handle?.(
    SpadeClientMessage.parse({ type: "spade.status", requestId: "s" }),
    device,
  );
  expect(sent.at(-1)).toMatchObject({ type: "spade.status.result", status: { state: "ready" } });
  service.close?.();
  silent.closeAllConnections();
  await new Promise((resolve) => silent.close(resolve));
});

test("an upload's last part doesn't hold up the connection while Spade answers", async () => {
  const silent = createServer((request) => request.resume());
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port: address.port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
  });
  const device = DeviceId.parse("device");
  await service.handle?.(
    SpadeClientMessage.parse({
      type: "spade.http",
      requestId: "upload",
      method: "POST",
      path: "/v1/conversations/c1/messages",
      parts: 1,
    }),
    device,
  );
  expect(sent.at(-1)).toEqual({ type: "spade.http.open", requestId: "upload" });
  const handled = await Promise.race([
    Promise.resolve(
      service.handle?.(
        SpadeClientMessage.parse({
          type: "spade.http.part",
          requestId: "upload",
          index: 0,
          body: '{"text":"hi"}',
        }),
        device,
      ),
    ).then(() => "handled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
  ]);
  expect(handled).toBe("handled");
  service.close?.();
  silent.closeAllConnections();
  await new Promise((resolve) => silent.close(resolve));
});

/** A session forwarding to a Spade at `port`, holding every scope. */
function readySession(port: number) {
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
  });
  const device = DeviceId.parse("device");
  const handle = (message: z.input<typeof SpadeClientMessage>) =>
    service.handle?.(SpadeClientMessage.parse(message), device);
  /** The `spade.http.result` for `requestId`, once it came. */
  const result = async (requestId: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const found = sent.find(
        (message) => message.type === "spade.http.result" && message.requestId === requestId,
      );
      if (found?.type === "spade.http.result") return found.result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No result for ${requestId}`);
  };
  return { handle, result, sent, close: () => service.close?.() };
}

test("media as large as Spade takes passes both ways, and a text window keeps the small cap", async () => {
  const documentBytes = 2 * 1024 * 1024;
  const spade = createServer((request, response) => {
    let length = 0;
    request.on("data", (chunk: Buffer) => (length += chunk.length));
    request.on("end", () => {
      if (request.url === "/v1/transcriptions") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ text: String(length) }));
      } else {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(Buffer.alloc(documentBytes, 7));
      }
    });
  });
  await new Promise<void>((resolve) => spade.listen(0, "127.0.0.1", resolve));
  const address = spade.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const { handle, result, sent, close } = readySession(address.port);

  // A recording of about a minute: 1.5 MB of JSON, more than the small routes take.
  const part = "a".repeat(180 * 1024);
  const parts = 8;
  await handle({
    type: "spade.http",
    requestId: "voice",
    method: "POST",
    path: "/v1/transcriptions",
    parts,
  });
  for (let index = 0; index < parts; index++)
    await handle({ type: "spade.http.part", requestId: "voice", index, body: part });
  expect(await result("voice")).toMatchObject({
    kind: "response",
    status: 200,
    body: JSON.stringify({ text: String(part.length * parts) }),
  });

  await handle({ type: "spade.http", requestId: "doc", method: "GET", path: "/v1/documents/ab12" });
  expect(await result("doc")).toMatchObject({ kind: "response", status: 200, encoding: "base64" });
  await handle({ type: "spade.http", requestId: "audio", method: "GET", path: "/v1/audio/ab12" });
  expect(await result("audio")).toMatchObject({ kind: "response", status: 200 });
  // A text window is small JSON: the same 2 MB there is more than the route takes.
  await handle({
    type: "spade.http",
    requestId: "text",
    method: "GET",
    path: "/v1/documents/ab12/text?offset=0",
  });
  expect(await result("text")).toMatchObject({ kind: "error", code: "too_large" });

  // A message with eight 32 MB documents needs more than two thousand parts.
  await handle({
    type: "spade.http",
    requestId: "message",
    method: "POST",
    path: "/v1/conversations/c1/messages",
    parts: 2200,
  });
  expect(sent.at(-1)).toEqual({ type: "spade.http.open", requestId: "message" });

  close();
  spade.closeAllConnections();
  await new Promise((resolve) => spade.close(resolve));
});
