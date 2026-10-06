import { expect, test } from "vitest";
import { placePinned, type PinMove, type PinnedPlace } from "./pin-order.ts";

const pins = (...entries: [string, number | undefined][]): PinnedPlace[] =>
  entries.map(([id, order]) => ({ id, order }));

/** The Pinned group after applying `moves`, top first, as Home sorts it. */
function after(pinned: PinnedPlace[], moves: PinMove[]): string[] {
  const orders = new Map(pinned.map((pin) => [pin.id, pin.order ?? 0]));
  for (const move of moves) orders.set(move.id, move.order);
  return [...orders].toSorted((a, b) => b[1] - a[1]).map(([id]) => id);
}

test("dragging a pinned thread down names one new place, between its new neighbours", () => {
  const pinned = pins(["a", 30], ["b", 20], ["c", 10]);
  const moves = placePinned(pinned, ["a"], 2);
  expect(moves).toHaveLength(1);
  expect(after(pinned, moves)).toEqual(["b", "c", "a"]);
});

test("dropping a thread at the top or bottom of the group puts it there", () => {
  const pinned = pins(["a", 30], ["b", 20]);
  expect(after(pinned, placePinned(pinned, ["b"], 0))).toEqual(["b", "a"]);
  // Pinning by drag: the new thread isn't in the group yet.
  expect(after(pinned, placePinned(pinned, ["new"], 2))).toEqual(["a", "b", "new"]);
  expect(after(pinned, placePinned(pinned, ["new"], 0))).toEqual(["new", "a", "b"]);
  expect(after([], placePinned([], ["only"], 0))).toEqual(["only"]);
});

test("dropping a thread where it already is changes nothing", () => {
  const pinned = pins(["a", 30], ["b", 20], ["c", 10]);
  expect(placePinned(pinned, ["b"], 1)).toEqual([]);
});

test("several threads dropped together keep their order between the neighbours", () => {
  const pinned = pins(["a", 30], ["b", 20]);
  const moves = placePinned(pinned, ["x", "y", "z"], 1);
  expect(after(pinned, moves)).toEqual(["a", "x", "y", "z", "b"]);
});

test("pins from before places existed are given fresh places so a drop between them holds", () => {
  const pinned = pins(["a", undefined], ["b", undefined], ["c", undefined]);
  const moves = placePinned(pinned, ["c"], 1);
  expect(after(pinned, moves)).toEqual(["a", "c", "b"]);
});

test("a gap halved past what a number can hold starts the group's places afresh", () => {
  let pinned = pins(["a", 1_700_000_000_001], ["b", 1_700_000_000_000], ["c", 5]);
  // Keep dropping the bottom thread just under the top one: each drop halves that gap.
  for (let drop = 0; drop < 80; drop++) {
    const last = pinned.at(-1)?.id ?? "";
    const expected = ["a", last, ...pinned.slice(1, -1).map((pin) => pin.id)];
    const moves = placePinned(pinned, [last], 1);
    const orders = new Map(pinned.map((pin) => [pin.id, pin.order]));
    for (const move of moves) orders.set(move.id, move.order);
    pinned = [...orders]
      .map(([id, order]) => ({ id, order }))
      .toSorted((x, y) => (y.order ?? 0) - (x.order ?? 0));
    expect(pinned.map((pin) => pin.id)).toEqual(expected);
    expect(new Set(pinned.map((pin) => pin.order)).size).toBe(3);
  }
});
