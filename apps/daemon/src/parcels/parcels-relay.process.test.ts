import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ParcelId, type ThreadId } from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { pairedMachines } from "../machines/machine-test-support.ts";
import { MachineFailure, pinnedRequest } from "../machines/transport.ts";
import { selfSignedCertificate } from "../self-signed-certificate.ts";
import type { ParcelLinkDeps } from "./link.ts";
import {
  arrived,
  callAs,
  delegateChild,
  folderOf,
  randomFile,
  type Pair,
} from "./parcel-test-support.ts";

const Sent = z.object({ parcelId: ParcelId });
const Entry = z.object({ parcelId: z.string(), state: z.string(), path: z.string().optional() });
const Listed = z.object({ received: z.array(Entry), sent: z.array(Entry) });

/** Waits for the sending thread's own list to show its parcel delivered. */
async function settled(side: Pair["source"], threadId: ThreadId, parcelId: string) {
  await vi.waitFor(
    async () => {
      const listed = Listed.parse((await callAs(side, threadId, { op: "data.receive" })).data);
      expect(listed.sent.find((entry) => entry.parcelId === parcelId)?.state).toBe("delivered");
    },
    { timeout: 30_000 },
  );
}

// The relay's TLS certificate is self-signed, so it isn't what proves the machine: the stream
// inside is pinned to the target's relay host key (Noise), which is what this test relies on.
const trust = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
beforeEach(() => {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
});
afterEach(() => {
  if (trust === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = trust;
});

it("with no direct path between the machines, a parcel each way goes through the person's own relay", async () => {
  const certificate = selfSignedCertificate({ commonName: "127.0.0.1", days: 2, now: new Date() });
  const relay = await startRelay({ tls: { cert: certificate.cert, key: certificate.key } });
  if (!relay.tlsPort) throw new Error("The relay serves no TLS");
  const relayUrl = `wss://127.0.0.1:${relay.tlsPort}`;
  const state = { direct: 0, down: false };
  const pinned: ParcelLinkDeps["pinned"] = async (profile, route, options) => {
    state.direct++;
    if (state.down) throw new MachineFailure("offline");
    return pinnedRequest(profile, route, options);
  };
  try {
    const pair = await pairedMachines({
      access: "operate",
      targetEnv: { ACE_RELAY_URL: relayUrl },
      sourceParcels: { pinned, pollMs: 50 },
    });
    const parent = pair.source.caller.threadId;
    // Linked over the LAN, which tells the source the relay the target is on.
    await vi.waitFor(() => expect(pair.target.daemon.relayHostId).toBeTruthy(), {
      timeout: 15_000,
    });
    const child = await delegateChild(pair);
    const file = randomFile(await folderOf(pair.target, child), "logs.bin", 400 * 1024);

    // Now neither the LAN nor Tailscale reaches the target from the source.
    state.down = true;
    const down = state.direct;
    // The child's result goes back to its parent first, collected through the relay.
    const toParent = Sent.parse(
      (await callAs(pair.target, child, { op: "data.send", to: "parent", path: "logs.bin" })).data,
    );
    const back = await arrived(pair.source, parent, toParent.parcelId);
    expect(back.bytes.equals(file.data)).toBe(true);
    // The child's machine settled it as delivered once the parent's had it.
    await settled(pair.target, child, toParent.parcelId);

    // Then the parent's instructions go to the child, pushed through the relay.
    const toChild = Sent.parse(
      (
        await pair.source.call({
          op: "data.send",
          to: child,
          text: "The build server's credentials stay on that machine; use the cached artifacts.",
          name: "instructions.txt",
        })
      ).data,
    );
    // Its notice waits in the child's queue behind the turn it is in; the copy is there now.
    let path: string | undefined;
    await vi.waitFor(
      async () => {
        const listed = Listed.parse(
          (await callAs(pair.target, child, { op: "data.receive" })).data,
        );
        path = listed.received.find(
          (entry) => entry.parcelId === toChild.parcelId && entry.state === "received",
        )?.path;
        expect(path).toBeTruthy();
      },
      { timeout: 30_000 },
    );
    expect(readFileSync(path ?? "", "utf8")).toContain("use the cached artifacts");
    await settled(pair.source, parent, toChild.parcelId);
    // The direct path was tried and refused every time: the relay carried both.
    expect(state.direct).toBeGreaterThan(down);
  } finally {
    await relay.close();
  }
});
