import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import { machineCodeGate } from "./machine-code-gate.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";

/**
 * An account device's client on manual timers, whose daemon asks for the machine code. Every
 * socket's hello is recorded, so a reconnect shows as a new hello and what it carried.
 */
function harness() {
  const sockets: { events: TransportEvents; sent: string[] }[] = [];
  const gate = machineCodeGate(async () => "grant");
  const client = new Client({
    deviceId: DeviceId.parse("install-1"),
    transport: () => {
      const socket = { events: undefined as unknown as TransportEvents, sent: [] as string[] };
      return {
        open(events) {
          socket.events = events;
          sockets.push(socket);
          events.open();
        },
        send(text) {
          socket.sent.push(text);
        },
        close() {},
      };
    },
    credential: () => gate.credential(),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
    now: () => 1_000_000,
    limits: { ...defaultLimits, heartbeatMs: 700_000, healthyMs: 500_000 },
  });
  const hello = async (index: number) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = sockets[index]?.sent[0];
    if (!text) throw new Error(`socket ${index} sent no hello`);
    return JSON.parse(text) as { machineCode?: string };
  };
  const answer = (index: number, frame: object) =>
    sockets[index]?.events.message(JSON.stringify(frame));
  return { client, gate, sockets, hello, answer };
}

test("a typed machine code reconnects at once and goes with the next hello", async () => {
  const { client, gate, sockets, hello, answer } = harness();
  await client.start();
  expect((await hello(0)).machineCode).toBeUndefined();
  answer(0, {
    type: "error",
    code: "machine_code_required",
    message: "Enter this machine's code.",
  });
  gate.refused("machine_code_required");
  expect(client.state).toBe("fatal");

  gate.enter("2468");
  client.codeEntered();
  expect(sockets).toHaveLength(2);
  expect((await hello(1)).machineCode).toBe("2468");
  answer(1, { type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  expect(client.state).toBe("ready");
  expect(client.error).toBeUndefined();
});

test("a connection refused for another reason stays stopped when a code is typed", async () => {
  const { client, gate, sockets, hello, answer } = harness();
  await client.start();
  await hello(0);
  answer(0, { type: "error", code: "unauthorized", message: "Valid hello required" });
  expect(client.state).toBe("fatal");

  gate.enter("2468");
  client.codeEntered();
  expect(sockets).toHaveLength(1);
  expect(client.state).toBe("fatal");
});
