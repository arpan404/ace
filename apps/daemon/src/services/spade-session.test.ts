import { expect, test } from "vitest";
import {
  DeviceId,
  type DeviceScope,
  type ServerMessage,
  type SpadeClientMessage,
} from "@ace/protocol";
import { SpadeHost } from "../spade/host.ts";
import { createSpadeSession } from "./spade-session.ts";

/** A session for a device holding `scopes`, with Spade off (no binary). */
function session(scopes: readonly DeviceScope[]) {
  const sent: ServerMessage[] = [];
  const spade = new SpadeHost({
    dataDir: "/ace/spade",
    binary: () => undefined,
    credentials: async () => ({ env: {}, revoke: () => {} }),
    runtime: {
      spawn: () => {
        throw new Error("Spade has no binary here");
      },
      readText: async () => undefined,
      ensureDirectory: () => {},
      healthy: async () => false,
      now: () => 0,
      sleep: async () => {},
    },
    log: () => {},
  });
  const service = createSpadeSession({
    options: { spade },
    authorize: (scope) => scopes.includes(scope),
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
  });
  const handle = async (message: SpadeClientMessage) => {
    await service.handle?.(message, DeviceId.parse("device"));
    return sent.at(-1);
  };
  return { handle, sent };
}

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
