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
  return { handle, sent, revocations: () => revocations };
}

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
