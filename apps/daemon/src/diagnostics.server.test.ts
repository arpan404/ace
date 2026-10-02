import { Command, DiagnosticsHealth } from "@ace/protocol";
import { expect, it } from "vitest";
import { setup as remoteFixture } from "./remote-test-support.ts";
import { fixture } from "./socket-test-support.ts";
function health(at: number) {
  return DiagnosticsHealth.parse({
    at,
    eventLoop: { meanMs: null, p99Ms: null, maxMs: null },
    memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
    openHandles: 0,
    sqlite: { pageBytes: 1, walBytes: 0 },
    activeSessions: null,
    queues: {},
    logs: { dropped: 0, failed: 0, queued: 0 },
  });
}
it("authenticated health commands return current measurements on retries without changing the event log", async () => {
  let at = 0;
  const f = await fixture({ health: async () => health(++at) });
  try {
    const client = await f.connect();
    await client.next();
    const command = Command.parse({
      id: "health-1",
      deviceId: "device",
      payload: { type: "diagnostics.health" },
    });
    client.send({ type: "command", command });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: true,
      health: { at: 1 },
    });
    client.send({ type: "command", command });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: true,
      health: { at: 2 },
    });
    expect(f.store.headSeq()).toBe(1);
    command.deviceId = Command.parse({
      id: "other",
      deviceId: "different",
      payload: { type: "diagnostics.health" },
    }).deviceId;
    client.send({ type: "command", command });
    expect(await client.next()).toMatchObject({ type: "error", code: "device_mismatch" });
  } finally {
    await f.close();
  }
});
const noop = () => {};
it("one pending health request per socket bounds waiting responses and a failed sample returns an error", async () => {
  let reject: (error: Error) => void = noop;
  const pending = new Promise<DiagnosticsHealth>((_resolve, fail) => {
    reject = fail;
  });
  const f = await fixture({ health: () => pending });
  try {
    const client = await f.connect();
    await client.next();
    for (const id of ["first", "second"])
      client.send({
        type: "command",
        command: Command.parse({ id, deviceId: "device", payload: { type: "diagnostics.health" } }),
      });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: "second",
      ok: false,
      error: "diagnostics_busy",
    });
    expect(f.server.diagnosticsQueues().healthRequests).toBe(1);
    reject(new Error("secret"));
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: "first",
      ok: false,
      error: "diagnostics_failed",
    });
    expect(f.server.diagnosticsQueues()).toEqual({ socketInput: 0, healthRequests: 0 });
  } finally {
    await f.close();
  }
});

it("a paired read-only device can request health through its authenticated socket ticket", async () => {
  const f = await remoteFixture({ health: async () => health(7) });
  const paired = await f.pair(["read"]);
  const issued = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, issued.ticket);
  await client.next();
  client.send({
    type: "command",
    command: Command.parse({
      id: "reader-health",
      deviceId: paired.device.id,
      payload: { type: "diagnostics.health" },
    }),
  });
  expect(await client.next()).toMatchObject({ type: "commandResult", ok: true, health: { at: 7 } });
});
