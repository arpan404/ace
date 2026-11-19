import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MachinePath, transferRelayPieceBytes, type TransferRelayRequest } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { enrollPins } from "../machines/link-routes.ts";
import { MachineLink } from "../machines/machine-link.ts";
import {
  TransfersNotOffered,
  transfersNotOffered,
  type RelayTarget,
} from "../machines/relay-link.ts";
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
  let stored = Buffer.alloc(0);
  /** Bytes each route wrote, and copies of bytes it already held that each route carried. */
  const wrote: Record<string, number> = {};
  const checked: Record<string, number> = {};
  const take = (via: string, offset: number, data: Buffer) => {
    if (offset === stored.length) {
      stored = Buffer.concat([stored, data]);
      wrote[via] = (wrote[via] ?? 0) + data.length;
    } else if (offset < stored.length) {
      // A copy of bytes it holds: they must be the same bytes, or the upload is wrong.
      const held = stored.subarray(offset, offset + data.length);
      if (!held.equals(data.subarray(0, held.length)))
        throw new Error("A copy of a chunk carried other bytes");
      checked[via] = (checked[via] ?? 0) + held.length;
    }
    return { offset: stored.length };
  };
  const status = (via: string) => ({
    transferId: "t-1",
    state: "receiving",
    method: "bundle",
    offset: stored.length,
    via,
  });
  return {
    held: () => stored.length,
    wrote: (via: string) => wrote[via] ?? 0,
    checked: (via: string) => checked[via] ?? 0,
    /** The upload's bytes as the target wrote them. */
    bytes: () => stored,
    answer(via: string, request: PinnedRequest): unknown {
      const url = new URL(request.path, "https://ace.invalid");
      if (url.pathname.endsWith("/chunk"))
        return take(via, Number(url.searchParams.get("offset")), Buffer.from(request.body));
      return status(via);
    },
    relayed(via: string, request: TransferRelayRequest): unknown {
      if (request.kind === "call") return status(via);
      const data = Buffer.from(request.data, "base64");
      if (data.length > transferRelayPieceBytes)
        throw new Error("A piece larger than a relay takes");
      return take(via, request.offset, data);
    },
  };
}

/** How a route behaves: `loses` writes what it was sent, then its answer never arrives; `old`
 * is an older machine's relay stream, which offers no transfers. */
type Reach = "answers" | "offline" | "refuses" | "loses" | "old";
function world(options: {
  profile: RemoteProfile;
  paths?: MachinePath[];
  direct: () => Reach;
  relays?: Record<string, Reach>;
  paired?: () => boolean;
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
    const answer = there.answer("direct", request);
    if (reach === "loses") throw new MachineFailure("disconnected");
    return answer;
  };
  const links: MachineLinks = {
    machines: new MachineLink({
      paths: () => options.paths ?? [],
      hosted: (url) => url === acePath.url,
      // The keys this pairing enrolled from the machine's description, as parcels keep them.
      pins: (profile) => enrollPins(profile, {}, options.paths ?? []),
      now: () => at,
    }),
    relay: {
      async transfer(target: RelayTarget, request: TransferRelayRequest) {
        const reach = options.relays?.[target.url] ?? "offline";
        if (reach === "offline") throw new MachineFailure("offline");
        if (reach === "refuses") throw new MachineFailure("refused", "unauthorized");
        if (reach === "old")
          throw new TransfersNotOffered("offline", undefined, transfersNotOffered);
        answered.push(`relay ${target.url}`);
        const answer = there.relayed(target.url, request);
        if (reach === "loses") throw new MachineFailure("disconnected");
        return answer;
      },
    },
  };
  const transport = routedTransfers({
    direct,
    links: () => links,
    current: options.paired ?? (() => true),
    now: () => (at += 1),
  });
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

describe("a transfer stays correct and private however its routes fail", () => {
  it("lands the exact bytes when the address writes a chunk but its answer is lost, and the relay carries it again", async () => {
    let address: Reach = "loses";
    const { client, there } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      direct: () => address,
      relays: { [ownRelay.url]: "answers" },
    });
    const first = randomBytes(3 * MiB);
    const second = randomBytes(2 * MiB);
    // The address wrote the first chunk and its answer was lost: the relay carries it again, in
    // pieces the target checks against what it holds.
    await expect(client.chunk("t-1", 0, first)).resolves.toBe(first.length);
    expect(there.wrote(ownRelay.url)).toBe(0);
    expect(there.checked(ownRelay.url)).toBeGreaterThan(0);
    // Then the address is gone: the relay alone carries the second chunk's bytes.
    address = "offline";
    await expect(client.chunk("t-1", first.length, second)).resolves.toBe(5 * MiB);
    expect(there.wrote(ownRelay.url)).toBe(second.length);
    expect(there.bytes().equals(Buffer.concat([first, second]))).toBe(true);
  });
  it("goes on to the address when the relay that answered lately is an older machine's", async () => {
    let address: Reach = "offline";
    const relays: Record<string, Reach> = { [ownRelay.url]: "answers" };
    const { client, there, answered } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      direct: () => address,
      relays,
    });
    // A status went through the relay, so it is tried first; then an older ace answers on that
    // relay while the address answers again.
    await client.call({ op: "status", transferId: "t-1" });
    expect(answered).toEqual([`relay ${ownRelay.url}`]);
    address = "answers";
    relays[ownRelay.url] = "old";
    const data = randomBytes(MiB);
    await expect(client.chunk("t-1", 0, data)).resolves.toBe(MiB);
    expect(there.bytes().equals(data)).toBe(true);
  });
  it("tells the person to update ace there when only an older machine's relay reaches it", async () => {
    const { client } = world({
      profile: studio({ relay: ownRelay }),
      direct: () => "answers",
      relays: { [ownRelay.url]: "old" },
    });
    await expect(client.call({ op: "status", transferId: "t-1" })).rejects.toMatchObject({
      kind: "refused",
      message: transfersNotOffered,
      final: true,
    });
  });
  it("says to update ace there when an older machine's relay failed before an address that didn't answer", async () => {
    let address: Reach = "offline";
    const relays: Record<string, Reach> = { [ownRelay.url]: "answers" };
    const { client } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      direct: () => address,
      relays,
    });
    // The relay answered lately, so it goes first; then an older ace answers there.
    await client.call({ op: "status", transferId: "t-1" });
    relays[ownRelay.url] = "old";
    address = "offline";
    await expect(client.chunk("t-1", 0, randomBytes(MiB))).rejects.toMatchObject({
      kind: "refused",
      message: transfersNotOffered,
    });
  });
  it("sends nothing on any route once the pairing is no longer saved", async () => {
    const { client, there } = world({
      profile: studio({ ...linkedOnLan, relay: ownRelay }),
      paths: [
        MachinePath.parse({
          kind: "lan",
          url: "https://10.0.0.4:7443",
          fingerprint: "a".repeat(64),
        }),
      ],
      direct: () => "answers",
      relays: { [ownRelay.url]: "answers" },
      paired: () => false,
    });
    await expect(client.chunk("t-1", 0, randomBytes(MiB))).rejects.toMatchObject({
      kind: "offline",
    });
    expect(there.held()).toBe(0);
  });
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
