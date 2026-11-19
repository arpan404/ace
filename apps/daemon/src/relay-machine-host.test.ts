import { expect, it } from "vitest";
import {
  Device,
  DeviceId,
  type ClientMessage,
  type MachineRelayAnswer,
  type ServerMessage,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import { serveRelayMachineCalls } from "./relay-machine-host.ts";
import { HOSTED_RELAY_TRANSFER_BYTES } from "./transfers/route-policy.ts";
import type { TransferTarget } from "./transfers/serve.ts";

/** A relay `machine` stream from a paired machine: it sends `frames`, then waits for answers. */
function stream(frames: ClientMessage[]) {
  const sent: ServerMessage[] = [];
  const { promise: closed, resolve } = Promise.withResolvers<undefined>();
  const close = () => resolve(undefined);
  const channel = {
    closed,
    async send(message: ServerMessage) {
      sent.push(message);
    },
    async *frames() {
      for (const frame of frames) yield frame;
      await closed;
    },
  };
  // Only what serving machine calls uses of a channel is here.
  return { channel: channel as unknown as HostChannel, sent, close };
}

/** This machine's end of transfers: it counts the bytes of every chunk that reaches it. */
function transfers() {
  let held = 0;
  const owner = {
    hostId: "host-studio",
    hostName: async () => "Studio",
    log: () => {},
    incoming: {
      async chunk(_device: Device, _id: string, offset: number, data: Buffer) {
        held += data.length;
        return { offset: offset + data.length };
      },
    },
  };
  // Only chunks reach it in this test.
  return { owner: owner as unknown as TransferTarget, held: () => held };
}

const device = {
  ...Device.parse({
    id: "device-laptop",
    name: "Laptop",
    scopes: ["read", "operate", "projects"],
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  }),
  generation: "1",
  person: false,
};
const chunk = (offset: number): ClientMessage => ({
  type: "machine.transfer",
  id: 1,
  request: {
    kind: "chunk",
    transferId: "t-1",
    offset,
    part: "code",
    data: Buffer.alloc(1024).toString("base64"),
  },
});

async function answerTo(frame: ClientMessage, hostedRelay: boolean) {
  const there = transfers();
  const { channel, sent, close } = stream([frame]);
  const serving = serveRelayMachineCalls(channel, {
    target: () => undefined,
    transfers: () => there.owner,
    hostedRelay,
    device: () => device,
    deviceId: DeviceId.parse("device-laptop"),
    hostId: "host-studio",
    headSeq: () => 0,
  });
  const answer = await new Promise<MachineRelayAnswer>((resolve) => {
    const look = () => {
      const found = sent.find((message) => message.type === "machine.answer");
      if (found?.type === "machine.answer") resolve(found);
      else setTimeout(look, 5);
    };
    look();
  });
  close();
  await serving;
  return { answer, held: there.held(), welcome: sent[0] };
}

it("refuses bulk past ace's relay bound on a stream that came through ace's relay", async () => {
  const { answer, held } = await answerTo(chunk(HOSTED_RELAY_TRANSFER_BYTES), true);
  expect(answer).toMatchObject({ status: 501, body: { error: "not_supported", final: true } });
  expect(held).toBe(0);
});

it("takes the same chunk on a stream through the person's own relay, and offers transfers", async () => {
  const { answer, welcome } = await answerTo(chunk(0), false);
  expect(answer).toMatchObject({ status: 200, body: { offset: 1024 } });
  expect(welcome).toMatchObject({ type: "welcome", machineTransfers: true });
});
