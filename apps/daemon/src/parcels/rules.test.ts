import { describe, expect, it } from "vitest";
import { parcelChunkBytes, type MachinePath } from "@ace/protocol";
import {
  admitChunk,
  heldAfterRestart,
  mayDeliverLocally,
  nextRange,
  parcelRoutes,
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

describe("a parcel tries every way to reach the machine, best first", () => {
  const saved = { origin: "https://192.168.1.4:7443/", fingerprint: "a".repeat(64) };
  const relayHostId = "A".repeat(52);
  const paths: MachinePath[] = [
    { kind: "relay", url: "wss://relay.example.com", relayHostId },
    { kind: "account", url: "wss://relay.acehq.dev", relayHostId },
    { kind: "loopback", url: "https://127.0.0.1:7443", fingerprint: "a".repeat(64) },
    { kind: "tailscale", url: "https://100.64.0.2:7443", fingerprint: "a".repeat(64) },
    { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: "a".repeat(64) },
    { kind: "lan", url: "https://10.0.0.9:7443", fingerprint: "b".repeat(64) },
  ];
  it("goes linked address, Tailscale, the person's relay, then ace's relay", () => {
    expect(parcelRoutes(saved, paths).map((route) => [route.kind, route.url])).toEqual([
      ["direct", "https://192.168.1.4:7443/"],
      ["direct", "https://100.64.0.2:7443"],
      ["relay", "wss://relay.example.com"],
      ["relay", "wss://relay.acehq.dev"],
    ]);
  });
  it("never tries loopback, which would reach this machine, or an address under another key", () => {
    const urls = parcelRoutes(saved, paths).map((route) => route.url);
    expect(urls).not.toContain("https://127.0.0.1:7443");
    expect(urls).not.toContain("https://10.0.0.9:7443");
  });
  it("marks only ace's relay as needing an account grant", () => {
    const relays = parcelRoutes(saved, paths).filter((route) => route.kind === "relay");
    expect(relays.map((route) => route.kind === "relay" && route.hosted)).toEqual([false, true]);
  });
  it("still has the linked address when the machine never said what else it serves", () => {
    expect(parcelRoutes(saved, [])).toHaveLength(1);
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
