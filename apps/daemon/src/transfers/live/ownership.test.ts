import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../store.ts";
import { OwnershipConflict, ThreadOwnership } from "./ownership.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "ace-ownership-"));
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ownership: () => new ThreadOwnership(store),
    restart() {
      store.close();
      store = new Store(path);
      return new ThreadOwnership(store);
    },
  };
}
const studio = { hostId: "studio", name: "Studio" };

describe("which machine owns a thread", () => {
  it("refuses new turns from the moment a move starts, and names where it went", async () => {
    const owned = (await open()).ownership();
    expect(owned.refusal("t")).toBeUndefined();
    owned.change("t", { to: "stopping", transferId: "x", peer: studio, at: 1 });
    expect(owned.refusal("t")?.code).toBe("thread_moving");
    owned.change("t", { to: "handing", transferId: "x", at: 2 });
    owned.change("t", { to: "moved", transferId: "x", peerThread: "t2", at: 3 });
    expect(owned.refusal("t")).toEqual({
      code: "thread_moved",
      detail: "This thread moved to Studio. Continue it there.",
    });
    expect(owned.get("t")?.peer.threadId).toBe("t2");
  });

  it("gives a stopped thread back before the hand-over, with nothing left recorded", async () => {
    const owned = (await open()).ownership();
    owned.change("t", { to: "stopping", transferId: "x", peer: studio, at: 1 });
    owned.change("t", { to: "local", transferId: "x", confirmed: false, at: 2 });
    expect(owned.get("t")).toBeUndefined();
  });

  it("keeps a handed-over thread until the other machine itself answers, across a restart", async () => {
    const home = await open();
    const owned = home.ownership();
    owned.change("t", { to: "stopping", transferId: "x", peer: studio, at: 1 });
    owned.change("t", { to: "handing", transferId: "x", at: 2 });
    const again = home.restart();
    expect(again.get("t")?.state).toBe("handing");
    expect(() =>
      again.change("t", { to: "local", transferId: "x", confirmed: false, at: 3 }),
    ).toThrow(OwnershipConflict);
    again.change("t", { to: "local", transferId: "x", confirmed: true, at: 4 });
    expect(again.refusal("t")).toBeUndefined();
  });

  it("never returns a moved thread, and never lets a second move take it", async () => {
    const owned = (await open()).ownership();
    owned.change("t", { to: "stopping", transferId: "x", peer: studio, at: 1 });
    expect(() =>
      owned.change("t", { to: "stopping", transferId: "y", peer: studio, at: 2 }),
    ).toThrow(OwnershipConflict);
    owned.change("t", { to: "handing", transferId: "x", at: 3 });
    owned.change("t", { to: "moved", transferId: "x", peerThread: "t2", at: 4 });
    expect(() =>
      owned.change("t", { to: "local", transferId: "x", confirmed: true, at: 5 }),
    ).toThrow(OwnershipConflict);
  });

  it("records the target's ownership once, and a repeat of the same hand-over changes nothing", async () => {
    const owned = (await open()).ownership();
    const first = owned.change("n", {
      to: "owned",
      transferId: "x",
      peer: { ...studio, threadId: "t" },
      epoch: 1,
      at: 1,
    });
    const repeat = owned.change("n", {
      to: "owned",
      transferId: "x",
      peer: { ...studio, threadId: "t" },
      epoch: 1,
      at: 9,
    });
    expect(repeat).toEqual(first);
    expect(owned.refusal("n")).toBeUndefined();
    expect(() =>
      owned.change("n", { to: "owned", transferId: "other", peer: studio, epoch: 2, at: 2 }),
    ).toThrow(OwnershipConflict);
  });

  it("moves a thread on again with a later epoch, and owns it again if that move fails", async () => {
    const owned = (await open()).ownership();
    owned.change("n", { to: "owned", transferId: "x", peer: studio, epoch: 1, at: 1 });
    const onward = owned.change("n", {
      to: "stopping",
      transferId: "y",
      peer: { hostId: "server", name: "Server" },
      at: 2,
    });
    expect(onward?.epoch).toBe(2);
    owned.change("n", { to: "local", transferId: "y", confirmed: false, at: 3 });
    expect(owned.get("n")).toMatchObject({
      state: "owned",
      epoch: 1,
      peer: studio,
      transferId: "x",
    });
  });
});
