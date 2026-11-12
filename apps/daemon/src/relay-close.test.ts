import { describe, expect, it } from "vitest";
import { RelayStreamClosed, type HostChannel } from "@ace/relay";
import { RelaySocket } from "./relay-socket.ts";
import { closeRecord, type ClosePeer } from "./socket-liveness.ts";

// Why a relayed main channel ended, as the daemon's close log tells it. The hosted relay's own
// closes (Durable Objects) can't run here, so the channel's end is given as the relay reports it.

/** A relayed channel that has already ended with `cause`; nothing else of it is used. */
function endedChannel(cause: Error | undefined): HostChannel {
  const partial: Partial<HostChannel> = { closed: Promise.resolve(cause), close() {} };
  return partial as HostChannel;
}

async function closeOf(cause: Error | undefined): Promise<[number, string]> {
  const socket = new RelaySocket(endedChannel(cause), { deflate: false, delay: () => () => {} });
  return new Promise((resolve) =>
    socket.once("close", (code: number, reason: Buffer) => resolve([code, reason.toString()])),
  );
}

const relayed: ClosePeer = { client: "unknown", remote: true, route: "relay" };
const direct: ClosePeer = { client: "ios", remote: true, access: "paired" };

describe("a relayed main channel's close", () => {
  it("keeps the relay's code and reason when the device's end went away", async () => {
    expect(await closeOf(new RelayStreamClosed(1000, "Peer closed"))).toEqual([
      1000,
      "Peer closed",
    ]);
  });

  it("keeps the relay's code when the relay itself ended the stream", async () => {
    expect(await closeOf(new RelayStreamClosed(1008, "Rate limit"))).toEqual([1008, "Rate limit"]);
  });

  it("reads as an abnormal close that says what broke when the channel failed", async () => {
    expect(await closeOf(new Error("Peer overran its flow window"))).toEqual([
      1006,
      "Peer overran its flow window",
    ]);
  });

  it("is logged as a relayed close even when the device hung up normally", () => {
    const record = closeRecord(1000, Buffer.from("Peer closed"), 2300, true, relayed);
    expect(record).toMatchObject({ code: 1000, reason: "Peer closed", route: "relay" });
  });

  it("leaves a direct socket's normal close out of the log", () => {
    expect(closeRecord(1000, Buffer.from(""), 2300, true, direct)).toBeUndefined();
    expect(closeRecord(1006, Buffer.from(""), 2300, true, direct)).toMatchObject({ code: 1006 });
  });
});
