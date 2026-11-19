import { describe, expect, it } from "vitest";
import { parcelChunkBytes } from "@ace/protocol";
import {
  admitChunk,
  heldAfterRestart,
  mayDeliverLocally,
  nextRange,
  projectRelative,
  retryDelay,
  type TreeThread,
} from "./rules.ts";

describe("a receiver takes only the next bytes of a parcel", () => {
  it("takes a chunk that starts where it holds bytes up to", () => {
    expect(admitChunk({ size: 10, held: 4 }, 4, 6)).toEqual({ ok: true });
  });
  it("writes nothing for a chunk sent again after its answer was lost", () => {
    expect(admitChunk({ size: 10, held: 8 }, 4, 4)).toEqual({ ok: false, refusal: "offset" });
  });
  it("writes nothing for a chunk from further ahead", () => {
    expect(admitChunk({ size: 10, held: 2 }, 6, 2)).toEqual({ ok: false, refusal: "offset" });
  });
  it("refuses a chunk that runs past the parcel's size or the chunk limit", () => {
    expect(admitChunk({ size: 10, held: 8 }, 8, 4)).toEqual({ ok: false, refusal: "overrun" });
    expect(admitChunk({ size: parcelChunkBytes * 2, held: 0 }, 0, parcelChunkBytes + 1)).toEqual({
      ok: false,
      refusal: "overrun",
    });
  });
  it("after a restart holds what is on disk, never more than recorded or the size", () => {
    expect(heldAfterRestart(100, 64, 1000)).toBe(64);
    expect(heldAfterRestart(32, 64, 1000)).toBe(32);
    expect(heldAfterRestart(2000, 2000, 1000)).toBe(1000);
  });
});

describe("a sender sends a parcel in bounded chunks from what is held", () => {
  it("walks the parcel to its end and then stops", () => {
    const size = parcelChunkBytes * 2 + 5;
    const ranges: { offset: number; length: number }[] = [];
    for (let held = 0, range = nextRange(0, size); range; range = nextRange(held, size)) {
      ranges.push(range);
      held = range.offset + range.length;
    }
    expect(ranges).toEqual([
      { offset: 0, length: parcelChunkBytes },
      { offset: parcelChunkBytes, length: parcelChunkBytes },
      { offset: parcelChunkBytes * 2, length: 5 },
    ]);
  });
  it("has nothing to send for an empty parcel", () => {
    expect(nextRange(0, 0)).toBeUndefined();
  });
  it("waits longer after each failed attempt, up to a minute", () => {
    expect(retryDelay(1)).toBe(1000);
    expect(retryDelay(2)).toBe(2000);
    expect(retryDelay(30)).toBe(60_000);
  });
});

describe("agents exchange data only within one agent tree", () => {
  const threads: Record<string, TreeThread> = {
    root: { id: "root", deleted: false },
    child: { id: "child", delegatedBy: "root", deleted: false },
    grandchild: { id: "grandchild", delegatedBy: "child", deleted: false },
    sibling: { id: "sibling", delegatedBy: "root", deleted: false },
    other: { id: "other", deleted: false },
    gone: { id: "gone", delegatedBy: "root", deleted: true },
    loopA: { id: "loopA", delegatedBy: "loopB", deleted: false },
    loopB: { id: "loopB", delegatedBy: "loopA", deleted: false },
  };
  const lookup = (id: string) => threads[id];
  it("lets parents, children and siblings of one tree send to each other", () => {
    expect(mayDeliverLocally("root", "grandchild", lookup)).toBe(true);
    expect(mayDeliverLocally("grandchild", "root", lookup)).toBe(true);
    expect(mayDeliverLocally("child", "sibling", lookup)).toBe(true);
  });
  it("refuses another tree, a deleted thread, the sender itself and a cycle", () => {
    expect(mayDeliverLocally("root", "other", lookup)).toBe(false);
    expect(mayDeliverLocally("root", "gone", lookup)).toBe(false);
    expect(mayDeliverLocally("root", "root", lookup)).toBe(false);
    expect(mayDeliverLocally("loopA", "loopB", lookup)).toBe(false);
  });
});

describe("a received parcel is saved only inside the project", () => {
  it("keeps a plain relative path", () => {
    expect(projectRelative("inputs/data.csv")).toBe("inputs/data.csv");
  });
  it("refuses leaving the project, absolute paths, the root itself and .git", () => {
    for (const path of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      ".",
      ".git/config",
      "a/.git/hooks/x",
      ".GIT/config",
    ])
      expect(projectRelative(path), path).toBeUndefined();
  });
});
