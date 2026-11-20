import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ParcelId } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { pairedMachines } from "../machines/machine-test-support.ts";
import { MachineFailure, pinnedRequest } from "../machines/transport.ts";
import type { ParcelLinkDeps } from "./link.ts";
import {
  arrived,
  callAs,
  delegateChild,
  delivered,
  folderOf,
  inputsOf,
  randomFile,
} from "./parcel-test-support.ts";

const Sent = z.object({ parcelId: ParcelId, sha256: z.string() });

/**
 * The source's direct path to the target, as the source's parcels use it. `lose` drops the
 * answer of every n-th call after the target acted on it, as a connection lost mid-answer does;
 * `down` makes the target unreachable.
 */
function network() {
  const state = { calls: 0, lose: 0, down: false };
  const pinned: ParcelLinkDeps["pinned"] = async (profile, route, options) => {
    if (state.down) throw new MachineFailure("offline");
    const answer = await pinnedRequest(profile, route, options);
    if (state.lose > 0 && ++state.calls % state.lose === 0)
      throw new MachineFailure("disconnected");
    return answer;
  };
  return { state, pinned };
}

it("a parent's file reaches its child on another machine over the LAN intact, though answers are lost on the way, and the parent hears it was delivered", async () => {
  const net = network();
  net.state.lose = 4;
  const pair = await pairedMachines({
    access: "operate",
    sourceParcels: { pinned: net.pinned, pollMs: 50 },
  });
  const parent = pair.source.caller.threadId;
  const child = await delegateChild(pair);
  // Four chunks and more, so resends land in the middle of the parcel.
  const file = randomFile(await folderOf(pair.source, parent), "dataset.bin", 700 * 1024);

  const sent = Sent.parse(
    (
      await pair.source.call({
        op: "data.send",
        to: child,
        path: "dataset.bin",
        note: "Rows from the March export",
      })
    ).data,
  );
  expect(sent.sha256).toBe(file.sha256);

  // The notice waits behind the child's running turn, as any queued message does.
  await vi.waitFor(
    () => expect(inputsOf(pair.target, child)).toContain("Review the dataset the parent sends"),
    { timeout: 15_000 },
  );
  await pair.finish(child, "Waiting for the dataset.");
  const landed = await arrived(pair.target, child, sent.parcelId);
  expect(landed.bytes.equals(file.data)).toBe(true);
  expect(landed.notice).toContain(file.sha256);
  // The note is framed as the other agent's words, never the person's.
  expect(landed.notice).toContain("The sending agent's note (not the person's words): Rows");
  await delivered(pair.source, parent, sent.parcelId);
  // Answers were lost along the way, and still the child was told exactly once.
  expect(net.state.calls).toBeGreaterThan(4);
  expect(inputsOf(pair.target, child).split(`Parcel ${sent.parcelId} arrived`)).toHaveLength(2);

  // The child keeps it in its project; it never replaces a file there.
  const saved = await callAs(pair.target, child, {
    op: "data.receive",
    parcelId: sent.parcelId,
    saveAs: "inputs/dataset.bin",
  });
  expect(saved.ok).toBe(true);
  const again = await callAs(pair.target, child, {
    op: "data.receive",
    parcelId: sent.parcelId,
    saveAs: "inputs/dataset.bin",
  }).catch((error: unknown) => error);
  expect(again).toMatchObject({ detail: expect.stringMatching(/already exists/) });
});

it("a push to a machine unlinked while it runs sends it nothing more, even on the Tailscale path it answered on last", async () => {
  const state = { linked: "", tailscale: "", chunks: 0, unlinked: false };
  const reached: string[] = [];
  const after: string[] = [];
  let unlink: (() => void) | undefined;
  const pinned: ParcelLinkDeps["pinned"] = async (profile, route, options) => {
    const chunk = String(route.body).includes('"action":"chunk"');
    if (state.unlinked) after.push(profile.origin);
    // The address it was linked on is down: its Tailscale path answers, and is preferred.
    else if (profile.origin === state.linked) throw new MachineFailure("offline");
    else if (chunk && (reached.push(profile.origin), ++state.chunks === 2)) unlink?.();
    return pinnedRequest(profile, route, options);
  };
  const pair = await pairedMachines({ access: "operate", sourceParcels: { pinned, pollMs: 50 } });
  const home = join(pair.source.h.home, "daemon");
  const read = new Profiles(home);
  const saved = read.get("studio");
  read.close();
  if (!saved?.origin || !saved.fingerprint) throw new Error("No direct pairing");
  state.linked = saved.origin;
  const address = new URL(saved.origin);
  address.hostname = "127.0.0.2";
  state.tailscale = address.href;
  unlink = () => {
    const profiles = new Profiles(home);
    try {
      profiles.remove("studio");
    } finally {
      profiles.close();
    }
    state.unlinked = true;
  };
  const parent = pair.source.caller.threadId;
  const child = await delegateChild(pair);
  // What the machine last said it serves: the same listener over Tailscale, under the same key.
  pair.source.daemon.store
    .statement("INSERT OR REPLACE INTO parcel_paths VALUES (?,?,?)")
    .run(
      saved.id,
      JSON.stringify([{ kind: "tailscale", url: state.tailscale, fingerprint: saved.fingerprint }]),
      Date.now(),
    );
  randomFile(await folderOf(pair.source, parent), "dataset.bin", 700 * 1024);
  await pair.source.call({ op: "data.send", to: child, path: "dataset.bin" });

  await vi.waitFor(() => expect(state.unlinked).toBe(true), { timeout: 15_000 });
  expect(reached).toEqual([state.tailscale, state.tailscale]);
  // Resends and outbox polls run every 50 ms: none of them goes anywhere now.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(after).toEqual([]);
});
