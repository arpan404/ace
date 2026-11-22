import { describe, expect, it, vi } from "vitest";
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
  const state = { saved: true, orgHost: false, reached: [] as string[] };
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
    orgHost: () => state.orgHost,
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

describe("a parcel call from an organization's host", () => {
  it("goes nowhere, on any route, once the machine is enrolled (ADR 0209 §4.2)", async () => {
    const { parcels, state } = link();
    // Before, a call reaches the machine.
    await parcels.call(profile, chunk, timing);
    expect(state.reached).not.toEqual([]);
    state.reached.length = 0;
    state.orgHost = true;
    await expect(parcels.call(profile, chunk, timing)).rejects.toMatchObject({
      kind: "refused",
      refusal: "machine_forbidden",
      final: true,
    });
    await expect(parcels.relays(profile, chunk, timing)).rejects.toMatchObject({
      kind: "refused",
    });
    expect(state.reached).toEqual([]);
  });
});

describe("a parcel call in flight when its machine is enrolled", () => {
  it("tries no further route, refuses to write once connected, and halts", async () => {
    // The first route fails after enrollment: the call never moves on to another one.
    const moved = link({
      "https://192.168.1.20:5870/": () => {
        moved.state.orgHost = true;
        throw new MachineFailure("offline");
      },
    });
    await expect(moved.parcels.call(profile, chunk, timing)).rejects.toMatchObject({
      kind: "refused",
    });
    expect(moved.state.reached).toEqual(["https://192.168.1.20:5870/"]);

    // A connected request is asked again before it writes anything.
    const state = { orgHost: false };
    let connectedCheck: (() => boolean) | undefined;
    const pinned = new ParcelLink({
      // A transport holding its connection open until its signal ends it, as a real one does.
      pinned: (_target, _route, options) => {
        connectedCheck = options.current;
        return new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
      relay: { call: () => Promise.resolve({ ok: true }) },
      paths: () => [],
      hosted: () => false,
      current: () => true,
      orgHost: () => state.orgHost,
      now: () => 1000,
    });
    const going = pinned.call(profile, chunk, timing);
    await vi.waitFor(() => expect(connectedCheck).toBeDefined());
    expect(connectedCheck?.()).toBe(true);
    state.orgHost = true;
    expect(connectedCheck?.()).toBe(false);
    // Enrollment halts what is still waiting on an answer.
    pinned.halt();
    await expect(going).rejects.toBeDefined();
  });
});
