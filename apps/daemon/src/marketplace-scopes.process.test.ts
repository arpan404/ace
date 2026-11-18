import type { Scope } from "./devices.ts";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";
import { sampleSkill, signedVersion } from "@ace/marketplace/testing";
import { expect, test } from "vitest";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./marketplace/test-support.ts";
import { setup } from "./remote-test-support.ts";

/*
 * Real paired-device sockets: the marketplace's scopes and its change push are wiring the
 * service's own tests can't reach (ADR 0168 §13: reads at read scope, the rest at admin).
 */

type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * A paired device's socket. Installing is the person's (ADR 0178 §12.7), so these devices are
 * ones the person paired, from a link made with the person's standing (ADR 0190); this test is
 * about scopes.
 */
async function connect(f: Fixture, sockets: WebSocket[], scopes: string[]) {
  const device = f.store.devices.create("Phone", scopes as Scope[], 1000, null, undefined, true);
  const ticket = await f.ticket(device.token);
  const socket = new WebSocket(f.server.url);
  sockets.push(socket);
  const frames: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    frames.push(ServerMessage.parse(JSON.parse(String(data))));
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (match: (message: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (;;) {
      const found = frames.findIndex(match);
      if (found >= 0) return frames.splice(found, 1)[0]!;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: device.device.id,
      ticket: ticket.ticket,
    }),
  );
  await next((message) => message.type === "welcome");
  const ask = async (requestId: string, operation: unknown) => {
    socket.send(JSON.stringify({ type: "marketplace.request", requestId, operation }));
    const answer = await next(
      (message) => message.type === "marketplace.result" && message.requestId === requestId,
    );
    return answer.type === "marketplace.result" ? answer.result : undefined;
  };
  return { ask, next };
}

test("a read device browses the marketplace and hears installs, but only an admin device installs", async () => {
  const market = await fakeMarket();
  const spade = await fakeSpade();
  const harness = await marketplaceHarness({ origin: market.origin, spade });
  const sockets: WebSocket[] = [];
  try {
    const files = sampleSkill();
    market.publish(signedVersion({ type: "spade-skill", name: "triage-mail", files }), files);
    const f = await setup({ marketplace: harness.service });
    const reader = await connect(f, sockets, ["read"]);
    const admin = await connect(f, sockets, ["admin"]);
    // Off in Settings › Beta, every request over the socket is answered as turned off.
    harness.hooks.on = false;
    expect(await admin.ask("off", { op: "search", query: "triage" })).toMatchObject({
      op: "error",
      code: "unavailable",
      message: expect.stringContaining("turned off"),
    });
    harness.hooks.on = true;
    expect(await reader.ask("refresh", { op: "refresh" })).toMatchObject({
      op: "error",
      code: "forbidden",
    });
    expect(await admin.ask("refresh", { op: "refresh" })).toMatchObject({ op: "sources" });
    expect(await reader.ask("search", { op: "search", query: "triage" })).toMatchObject({
      op: "search",
      entries: [{ name: "triage-mail" }],
    });
    expect(
      await reader.ask("prepare", {
        op: "prepare",
        source: "market",
        type: "spade-skill",
        name: "triage-mail",
      }),
    ).toMatchObject({
      code: "forbidden",
    });
    const prepared = await admin.ask("prepare", {
      op: "prepare",
      source: "market",
      type: "spade-skill",
      name: "triage-mail",
    });
    if (prepared?.op !== "review") throw new Error("Expected a review");
    expect(
      await reader.ask("install", {
        op: "install",
        id: prepared.review.id,
        hash: prepared.review.hash,
      }),
    ).toMatchObject({
      code: "forbidden",
    });
    expect(
      await admin.ask("install", {
        op: "install",
        id: prepared.review.id,
        hash: prepared.review.hash,
      }),
    ).toMatchObject({
      op: "done",
    });
    expect(
      await reader.next(
        (message) => message.type === "marketplace.changed" && message.installed > 0,
      ),
    ).toEqual({
      type: "marketplace.changed",
      installed: 1,
      updates: 0,
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await harness.close();
    await market.close();
    await spade.close();
  }
});
