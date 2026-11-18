import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ParcelId } from "@ace/protocol";
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

it("a child's result file reaches its parent on the delegating machine, and the child's tree isn't done until its parent has it", async () => {
  const net = network();
  const pair = await pairedMachines({
    access: "operate",
    sourceParcels: { pinned: net.pinned, pollMs: 50 },
  });
  const parent = pair.source.caller.threadId;
  const child = await delegateChild(pair);
  const file = randomFile(await folderOf(pair.target, child), "summary.bin", 300 * 1024);

  // The parent's machine can't collect it yet.
  net.state.down = true;
  const sent = Sent.parse(
    (await callAs(pair.target, child, { op: "data.send", to: "parent", path: "summary.bin" })).data,
  );
  // The child's agent finishes its turn while its parcel still waits for the parent.
  await vi.waitFor(
    () => expect(inputsOf(pair.target, child)).toContain("Review the dataset the parent sends"),
    { timeout: 15_000 },
  );
  await pair.finish(child, "Done; the summary is on its way.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(pair.target.daemon.store.getThread(child)?.status.state).not.toBe("done");

  net.state.down = false;
  const landed = await arrived(pair.source, parent, sent.parcelId);
  expect(landed.bytes.equals(file.data)).toBe(true);
  await delivered(pair.target, child, sent.parcelId);
});
