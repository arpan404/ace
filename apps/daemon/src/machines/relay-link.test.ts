import { describe, expect, it } from "vitest";
import { HostId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import type { ClientChannel } from "@ace/relay";
import { RelayLink, TransfersNotOffered, type RelayTarget } from "./relay-link.ts";
import { MachineUnpaired } from "./transport.ts";

/**
 * The other machine at the end of a relay stream: it welcomes the hello (offering transfers or
 * not, as an older ace doesn't) and answers each transfer frame. `sent` is what reached it.
 */
function machineThere(offers: boolean) {
  const sent: ClientMessage[] = [];
  const queue: ServerMessage[] = [];
  let wake: (() => void) | undefined;
  const state = { closed: false };
  const push = (message: ServerMessage) => {
    queue.push(message);
    wake?.();
  };
  const next = async (): Promise<ServerMessage | undefined> => {
    while (!queue.length && !state.closed) await new Promise<void>((resolve) => (wake = resolve));
    return queue.shift();
  };
  const channel = {
    flowControl() {},
    async send(message: ClientMessage) {
      sent.push(message);
      if (message.type === "hello")
        push({
          type: "welcome",
          hostId: HostId.parse("host-studio"),
          protocolVersion: 1,
          headSeq: 0,
          ...(offers ? { machineTransfers: true as const } : {}),
        });
      else if (message.type === "machine.transfer")
        push({ type: "machine.answer", id: message.id, status: 200, body: { offset: 0 } });
    },
    async receive() {
      const message = await next();
      if (!message) throw new Error("closed");
      return message;
    },
    async *frames() {
      for (let message = await next(); message; message = await next()) yield message;
    },
    close() {
      state.closed = true;
      wake?.();
    },
  };
  // Only what RelayLink uses of a channel is here.
  return { channel: channel as unknown as ClientChannel, sent };
}

const target = (hosted: boolean): RelayTarget => ({
  url: "wss://relay.example.com",
  relayHostId: "A".repeat(52),
  hosted,
  deviceId: "laptop",
  token: "c".repeat(64),
});
const status = { kind: "call" as const, call: { op: "status" as const, transferId: "t-1" } };
const transfersSent = (sent: ClientMessage[]) =>
  sent.filter((message) => message.type === "machine.transfer");
/** Whether the pairing's token went out: the hello carries it. */
const tokenSent = (sent: ClientMessage[]) => sent.some((message) => message.type === "hello");

function link(options: {
  connect: (grant: string | undefined) => Promise<ClientChannel>;
  current?: () => boolean;
}) {
  return new RelayLink({
    connect: async ({ grant }) => options.connect(grant),
    deviceGrant: async () => "grant-for-ace-relay",
    schedule: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    current: options.current ?? (() => true),
  });
}

describe("a transfer frame goes only where it can be taken, and only while it is still wanted", () => {
  it("sends an older machine no transfer frame, which reads as a route that can't take one", async () => {
    const there = machineThere(false);
    const relay = link({ connect: async () => there.channel });
    await expect(relay.transfer(target(false), status, { timeoutMs: 5000 })).rejects.toBeInstanceOf(
      TransfersNotOffered,
    );
    expect(transfersSent(there.sent)).toEqual([]);
    await relay.close();
  });
  it("sends not even its token when the caller gives up while the stream is still opening", async () => {
    const there = machineThere(true);
    const stop = new AbortController();
    const relay = link({
      connect: async () => {
        stop.abort();
        return there.channel;
      },
    });
    await expect(
      relay.transfer(target(false), status, { timeoutMs: 5000, signal: stop.signal }),
    ).rejects.toThrow();
    expect(tokenSent(there.sent)).toBe(false);
    await relay.close();
  });
  it("sends not even its token when the machine is unlinked while the stream is opening", async () => {
    const there = machineThere(true);
    let linked = true;
    const relay = link({
      connect: async () => {
        linked = false;
        return there.channel;
      },
      current: () => linked,
    });
    await expect(relay.transfer(target(false), status, { timeoutMs: 5000 })).rejects.toBeInstanceOf(
      MachineUnpaired,
    );
    expect(tokenSent(there.sent)).toBe(false);
    await relay.close();
  });
  it("still opens a stream another caller waits on when one of them gives up", async () => {
    const there = machineThere(true);
    const stop = new AbortController();
    const opened = Promise.withResolvers<ClientChannel>();
    const relay = link({ connect: () => opened.promise });
    const leaving = relay.transfer(target(false), status, { timeoutMs: 5000, signal: stop.signal });
    const staying = relay.transfer(target(false), status, { timeoutMs: 5000 });
    stop.abort();
    opened.resolve(there.channel);
    await expect(leaving).rejects.toThrow();
    await expect(staying).resolves.toEqual({ offset: 0 });
    expect(transfersSent(there.sent)).toHaveLength(1);
    await relay.close();
  });
  it("opens ace's relay and the person's own as separate streams, the account grant only on ace's", async () => {
    const grants: (string | undefined)[] = [];
    const relay = link({
      connect: async (grant) => {
        grants.push(grant);
        return machineThere(true).channel;
      },
    });
    await relay.transfer(target(true), status, { timeoutMs: 5000 });
    await relay.transfer(target(false), status, { timeoutMs: 5000 });
    expect(grants).toEqual(["grant-for-ace-relay", undefined]);
    await relay.close();
  });
});
