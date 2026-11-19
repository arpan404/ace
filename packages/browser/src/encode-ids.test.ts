import { expect, it } from "vitest";
import { EncodeIds, nextEncodeId } from "./encode-ids.ts";
import type { VideoEncode } from "./video-policy.ts";

const spec = (key: string): VideoEncode => ({
  key,
  codec: "avc1.42E033",
  width: 640,
  height: 400,
  fps: 30,
  bitrate: 1_000_000,
});
const ids = (stamped: { id: number }[]) => stamped.map((s) => s.id);

it("the daemon's ids stay in [2^20, 2^31), only grow, and never wrap", () => {
  const top = 2 ** 31 - 1;
  expect(nextEncodeId(top, new Set())).toEqual({ id: top, next: 2 ** 31 });
  expect(nextEncodeId(2 ** 31, new Set())).toBeUndefined();
  expect(nextEncodeId(top, new Set([top]))).toBeUndefined();
  // Below the range: its start.
  expect(nextEncodeId(0, new Set())).toEqual({ id: 2 ** 20, next: 2 ** 20 + 1 });
  expect(nextEncodeId(2 ** 20, new Set([2 ** 20, 2 ** 20 + 1]))).toEqual({
    id: 2 ** 20 + 2,
    next: 2 ** 20 + 3,
  });
});

it("out of daemon ids, the source is opened again; ids start over once every path open then has ended", () => {
  const first = 2 ** 20;
  let renewals = 0;
  const encodeIds = new EncodeIds({
    daemonIds: { first, end: first + 4 },
    renew: () => void renewals++,
  });
  encodeIds.pointed("m1");
  expect(ids(encodeIds.stamp(["a", "b", "c", "d"].map(spec)))).toEqual([
    first,
    first + 1,
    first + 2,
    first + 3,
  ]);
  // `a` keeps running; `e` finds no id left: it waits, and the source is asked to reopen.
  expect(encodeIds.stamp([spec("a"), spec("e")]).map((s) => s.key)).toEqual(["a"]);
  expect(renewals).toBe(1);
  expect(encodeIds.stamp([spec("a"), spec("e")]).map((s) => s.key)).toEqual(["a"]);
  expect(renewals).toBe(1);
  // The new path opens; the old one's late units still carry their own keys.
  encodeIds.pointed("m2");
  expect(encodeIds.key(first + 2, "m1")).toBe("c");
  expect(encodeIds.ended("m1")).toBe(true);
  // Ids start over, past `a`, which ran across the reopen and may still have units on the way.
  const after = encodeIds.stamp([spec("a"), spec("e"), spec("f")]);
  expect(ids(after)).toEqual([first, first + 1, first + 2]);
  expect(encodeIds.key(first + 1, "m2")).toBe("e");
  // `a` stops; its id still never goes to another encode before the next reopen.
  expect(ids(encodeIds.stamp([spec("e"), spec("f"), spec("g")]))).toEqual([
    first + 1,
    first + 2,
    first + 3,
  ]);
});

it("with no path open, out of daemon ids starts them over at once", () => {
  const first = 2 ** 20;
  let renewals = 0;
  const encodeIds = new EncodeIds({
    daemonIds: { first, end: first + 2 },
    renew: () => void renewals++,
  });
  encodeIds.stamp([spec("a"), spec("b")]);
  expect(ids(encodeIds.stamp([spec("c")]))).toEqual([first]);
  expect(renewals).toBe(1);
});

it("ace-media's ids belong to the path they came on, and only ids in [1, 2^20)", () => {
  const encodeIds = new EncodeIds({ renew: () => {} });
  // No path: nothing of ace-media's to run.
  expect(encodeIds.pin("media/1/x", 1)).toBe(false);
  encodeIds.pointed("m1");
  expect(encodeIds.pin("media/0/x", 0)).toBe(false);
  expect(encodeIds.pin("media/x", 2 ** 20)).toBe(false);
  expect(encodeIds.pin("media/1/a", 1)).toBe(true);
  expect(ids(encodeIds.stamp([spec("media/1/a")]))).toEqual([1]);
  // A new path: the old one's encodes stop, and its plan starts at 1 too.
  encodeIds.pointed("m2");
  expect(encodeIds.stamp([spec("media/1/a")])).toEqual([]);
  expect(encodeIds.pin("media/1/b", 1)).toBe(true);
  expect(encodeIds.key(1, "m2")).toBe("media/1/b");
  // The old path's late units keep their label until its end marker, then have none.
  expect(encodeIds.key(1, "m1")).toBe("media/1/a");
  encodeIds.ended("m1");
  expect(encodeIds.key(1, "m1")).toBeUndefined();
});
