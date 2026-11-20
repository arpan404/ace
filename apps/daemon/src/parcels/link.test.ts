import { describe, expect, it } from "vitest";
import { MachineCallRequest, type MachinePath } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineFailure, MachineUnpaired } from "../machines/transport.ts";
import { ParcelLink } from "./link.ts";

const fingerprint = "a".repeat(64);
const relayHostId = "A".repeat(52);
const profile = RemoteProfile.parse({
  id: "7f0c1c55-4e3b-4f53-9a49-3a7c2b0d5e11",
  name: "studio",
  origin: "https://192.168.1.20:5870/",
  fingerprint,
  relay: { url: "wss://relay.example.com/", relayHostId },
  deviceId: "source-device",
  token: "b".repeat(64),
});
const paths: MachinePath[] = [
  { kind: "tailscale", url: "https://100.64.0.2:5870/", fingerprint },
  { kind: "relay", url: "wss://relay-two.example.com/", relayHostId },
];
const chunk = MachineCallRequest.parse({
  origin: {
    hostId: "4b8f2a6e-1d3c-4e5f-8a7b-9c0d1e2f3a4b",
    hostName: "MacBook",
    threadId: "parent",
    threadTitle: "Parent",
    ceiling: "operate",
  },
  call: { op: "describe" },
});
const timing = { timeoutMs: 1000 };
/** The connection pool's refusal of a pairing no longer saved. */
const unpaired = () => {
  throw new MachineUnpaired("offline", undefined, "Machine call never sent: unpaired");
};

/**
 * A link to `profile` whose routes each answer by `answers` (a route not named answers), with
 * every request that reached a route, direct or relayed, in `reached`.
 */
function link(answers: Record<string, () => unknown> = {}) {
  const state = { saved: true, reached: [] as string[] };
  const answer = (url: string) => {
    state.reached.push(url);
    const reply = answers[url];
    return Promise.resolve().then(() => (reply ? reply() : { ok: true }));
  };
  const parcels = new ParcelLink({
    pinned: (target) => answer(target.origin),
    relay: { call: (target) => answer(target.url) },
    paths: () => paths,
    hosted: () => false,
    current: () => state.saved,
    now: () => 1000,
  });
  return { parcels, state };
}

describe("a parcel push to a machine unlinked while it runs", () => {
  it("sends its later chunks nowhere, though Tailscale answered last", async () => {
    const { parcels, state } = link({
      "https://192.168.1.20:5870/": () => {
        throw new MachineFailure("offline");
      },
    });
    expect((await parcels.call(profile, chunk, timing)).route).toBe("tailscale");
    expect(parcels.lastRoute(profile)).toBe("tailscale");

    state.saved = false;
    state.reached = [];
    await expect(parcels.call(profile, chunk, timing)).rejects.toBeInstanceOf(MachineUnpaired);
    await expect(parcels.relays(profile, chunk, timing)).rejects.toBeInstanceOf(MachineUnpaired);
    expect(state.reached).toEqual([]);
  });

  it("goes to no other route once the linked address's connections refuse the old pairing", async () => {
    const { parcels, state } = link({
      "https://192.168.1.20:5870/": unpaired,
      "wss://relay.example.com/": unpaired,
    });
    await expect(parcels.call(profile, chunk, timing)).rejects.toBeInstanceOf(MachineUnpaired);
    expect(state.reached).toEqual(["https://192.168.1.20:5870/"]);

    state.reached = [];
    await expect(parcels.relays(profile, chunk, timing)).rejects.toBeInstanceOf(MachineUnpaired);
    expect(state.reached).toEqual(["wss://relay.example.com/"]);
  });

  it("still goes on to the next route when one is only unreachable", async () => {
    const { parcels, state } = link({
      "https://192.168.1.20:5870/": () => {
        throw new MachineFailure("offline");
      },
      "https://100.64.0.2:5870/": () => {
        throw new MachineFailure("offline");
      },
    });
    expect((await parcels.call(profile, chunk, timing)).route).toBe("relay");
    expect(state.reached).toEqual([
      "https://192.168.1.20:5870/",
      "https://100.64.0.2:5870/",
      "wss://relay.example.com/",
    ]);
  });
});
