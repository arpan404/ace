import { describe, expect, it } from "vitest";
import { MachinePath, transferRelayPieceBytes, type TransferRelayRequest } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineLink } from "../machines/machine-link.ts";
import type { RelayTarget } from "../machines/relay-link.ts";
import { MachineFailure, type PinnedRequest } from "../machines/transport.ts";
import { TransferClient, type TransferTransport } from "./client.ts";
import { HOSTED_RELAY_TRANSFER_BYTES, hostedRelayRefusal } from "./route-policy.ts";
import { routedTransfers, type MachineLinks } from "./routes.ts";

const MiB = 1024 * 1024;
const relayHostId = "A".repeat(52);
const studio = (fields: Partial<RemoteProfile>): RemoteProfile =>
  RemoteProfile.parse({
    id: "6f1d2a4e-8b3c-4d5e-9f60-718293a4b5c6",
    name: "studio",
    deviceId: "laptop",
    token: "c".repeat(64),
    ...fields,
  });
const linkedOnLan = { origin: "https://192.168.1.4:7443/", fingerprint: "a".repeat(64) };
const ownRelay = { url: "wss://relay.example.com", relayHostId };
const acePath = MachinePath.parse({ kind: "account", url: "wss://relay.acehq.dev", relayHostId });

/**
 * The other machine's end of one transfer, as each route reaches it: it holds the upload's bytes
 * and takes a chunk only at the offset it holds, as `appendAt` does.
 */
function machine() {
  let held = 0;
  const take = (offset: number, data: Buffer) => {
    if (offset === held) held += data.length;
    return { offset: held };
  };
  const status = (via: string) => ({
    transferId: "t-1",
    state: "receiving",
    method: "bundle",
    offset: held,
    via,
  });
  return {
    held: () => held,
    answer(via: string, request: PinnedRequest): unknown {
      const url = new URL(request.path, "https://ace.invalid");
      if (url.pathname.endsWith("/chunk"))
        return take(Number(url.searchParams.get("offset")), Buffer.from(request.body));
      return status(via);
    },
    relayed(via: string, request: TransferRelayRequest): unknown {
      if (request.kind === "call") return status(via);
      const data = Buffer.from(request.data, "base64");
      if (data.length > transferRelayPieceBytes)
        throw new Error("A piece larger than a relay takes");
      return take(request.offset, data);
    },
  };
}

type Reach = "answers" | "offline" | "refuses";
function world(options: {
  profile: RemoteProfile;
  paths?: MachinePath[];
  direct: () => Reach;
  relays?: Record<string, Reach>;
}) {
  const there = machine();
  const answered: string[] = [];
  let at = 1000;
  const direct: TransferTransport = async (profile, request) => {
    const reach = options.direct();
    if (reach === "offline") throw new MachineFailure("offline");
    if (reach === "refuses")
      throw new MachineFailure("refused", "machine_forbidden", "Projects not allowed");
    answered.push(`direct ${profile.origin}`);
    return there.answer("direct", request);
  };
  const links: MachineLinks = {
    machines: new MachineLink({ paths: () => options.paths ?? [], now: () => at }),
    relay: {
      async transfer(target: RelayTarget, request: TransferRelayRequest) {
        const reach = options.relays?.[target.url] ?? "offline";
        if (reach === "offline") throw new MachineFailure("offline");
        if (reach === "refuses") throw new MachineFailure("refused", "unauthorized");
        answered.push(`relay ${target.url}`);
        return there.relayed(target.url, request);
      },
    },
  };
  const transport = routedTransfers({ direct, links: () => links, now: () => (at += 1) });
  return { client: new TransferClient(transport, options.profile), there, answered };
}

describe("a transfer reaches the other machine by any route that answers", () => {
  it("goes through the person's relay when the machines were linked through it only", async () => {
    const { client, answered } = world({
      profile: studio({ relay: ownRelay }),
      direct: () => "answers",
      relays: { [ownRelay.url]: "answers" },
    });
    await expect(client.call({ op: "status", transferId: "t-1" })).resolves.toMatchObject({
      state: "receiving",
    });
    expect(answered).toEqual([`relay ${ownRelay.url}`]);
  });
  it("goes on to the relay when the linked address doesn't answer", async () => {
    const { client, answered } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      direct: () => "offline",
      relays: { [ownRelay.url]: "answers" },
    });
    await client.call({ op: "status", transferId: "t-1" });
    expect(answered).toEqual([`relay ${ownRelay.url}`]);
  });
  it("never sends a call the machine refused on another route", async () => {
    const { client, answered } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      direct: () => "refuses",
      relays: { [ownRelay.url]: "answers" },
    });
    await expect(client.call({ op: "status", transferId: "t-1" })).rejects.toMatchObject({
      kind: "refused",
      refusal: "machine_forbidden",
    });
    expect(answered).toEqual([]);
  });
  it("lands a whole 4 MiB chunk through a relay, in pieces the relay takes", async () => {
    const { client, there } = world({
      profile: studio({ relay: ownRelay }),
      direct: () => "offline",
      relays: { [ownRelay.url]: "answers" },
    });
    const data = Buffer.alloc(4 * MiB, 7);
    await expect(client.chunk("t-1", 0, data)).resolves.toBe(4 * MiB);
    expect(there.held()).toBe(4 * MiB);
  });
  it("says where the target stands when it already held part of a chunk sent again", async () => {
    const { client, there } = world({
      profile: studio({ relay: ownRelay }),
      direct: () => "offline",
      relays: { [ownRelay.url]: "answers" },
    });
    await client.chunk("t-1", 0, Buffer.alloc(3 * MiB));
    // The answer to the first send was lost: it is sent again from 0, and nothing is written twice.
    await expect(client.chunk("t-1", 0, Buffer.alloc(4 * MiB))).resolves.toBe(3 * MiB);
    expect(there.held()).toBe(3 * MiB);
  });
});

/** A machine linked on the LAN that only ace's hosted relay reaches besides. */
const hostedOnly = (direct: () => Reach) =>
  world({
    profile: studio(linkedOnLan),
    paths: [acePath],
    direct,
    relays: { [acePath.url]: "answers" },
  });

describe("ace's hosted relay carries a transfer's control and small payloads only", () => {
  it("carries the control calls and a small project's code", async () => {
    const { client, there } = hostedOnly(() => "offline");
    await expect(client.call({ op: "status", transferId: "t-1" })).resolves.toMatchObject({
      state: "receiving",
    });
    await client.chunk("t-1", 0, Buffer.alloc(4 * MiB));
    expect(there.held()).toBe(4 * MiB);
  });
  it("refuses a bulk upload past its bound at once, saying what to do instead", async () => {
    const { client, there } = hostedOnly(() => "offline");
    await client.chunk("t-1", 0, Buffer.alloc(HOSTED_RELAY_TRANSFER_BYTES));
    await expect(
      client.chunk("t-1", HOSTED_RELAY_TRANSFER_BYTES, Buffer.alloc(MiB)),
    ).rejects.toMatchObject({ kind: "refused", message: hostedRelayRefusal, final: true });
    expect(there.held()).toBe(HOSTED_RELAY_TRANSFER_BYTES);
  });
  it("waits out a lost direct link that answered lately instead of refusing", async () => {
    let reach: Reach = "answers";
    const { client } = hostedOnly(() => reach);
    await client.chunk("t-1", 0, Buffer.alloc(HOSTED_RELAY_TRANSFER_BYTES));
    reach = "offline";
    await expect(
      client.chunk("t-1", HOSTED_RELAY_TRANSFER_BYTES, Buffer.alloc(MiB)),
    ).rejects.toMatchObject({ kind: "offline" });
  });
});
