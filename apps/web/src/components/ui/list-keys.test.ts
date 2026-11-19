import { describe, expect, test } from "vitest";
import { canPick, listKey, type ListKeyEvent } from "./list-keys.ts";

const press = (key: string, extra: Partial<ListKeyEvent> = {}): ListKeyEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...extra,
});
const any = () => true;

describe("moving the highlight", () => {
  test.each([
    ["↓ from none takes the first row", press("ArrowDown"), undefined, 0],
    ["↑ from none takes the last row", press("ArrowUp"), undefined, 3],
    ["↓ on the last row wraps to the first", press("ArrowDown"), 3, 0],
    ["↑ on the first row wraps to the last", press("ArrowUp"), 0, 3],
    ["Ctrl-N moves down", press("n", { ctrlKey: true }), 1, 2],
    ["Ctrl-P moves up", press("p", { ctrlKey: true }), 1, 0],
  ])("%s", (_, event, current, to) => {
    expect(listKey(event, { current, count: 4, pickable: any }, true)).toEqual({
      kind: "move",
      to,
    });
  });

  test("an empty list has nothing to highlight", () => {
    expect(
      listKey(press("ArrowDown"), { current: undefined, count: 0, pickable: any }, true),
    ).toEqual({ kind: "move", to: undefined });
  });

  test("⌘↑ is left to the field (up a folder)", () => {
    expect(
      listKey(press("ArrowUp", { metaKey: true }), { current: 2, count: 4, pickable: any }, true),
    ).toEqual({ kind: "pass" });
  });
});

describe("picking", () => {
  test("Enter picks the highlighted row, and ⌘Enter picks it the other way", () => {
    const list = { current: 2, count: 4, pickable: any };
    expect(listKey(press("Enter"), list, true)).toEqual({ kind: "pick", at: 2, how: "open" });
    expect(listKey(press("Enter", { metaKey: true }), list, true)).toEqual({
      kind: "pick",
      at: 2,
      how: "alternate",
    });
    // Off Apple platforms Ctrl is the modifier.
    expect(listKey(press("Enter", { ctrlKey: true }), list, false)).toEqual({
      kind: "pick",
      at: 2,
      how: "alternate",
    });
  });

  test("Enter with nothing highlighted passes, so the field or its form can act", () => {
    expect(listKey(press("Enter"), { current: undefined, count: 4, pickable: any }, true)).toEqual({
      kind: "pass",
    });
  });

  test("Enter on a row that can't be picked passes rather than picking it", () => {
    const list = { current: 1, count: 4, pickable: (at: number) => at !== 1 };
    expect(listKey(press("Enter"), list, true)).toEqual({ kind: "pass" });
  });

  test("keys go to the input method while it composes", () => {
    const list = { current: 1, count: 4, pickable: any };
    expect(listKey(press("Enter", { isComposing: true }), list, true)).toEqual({ kind: "pass" });
    expect(listKey(press("ArrowDown", { isComposing: true }), list, true)).toEqual({
      kind: "pass",
    });
  });
});

describe("which rows can be picked", () => {
  test.each([
    ["a current row", { stale: false }, false, true],
    ["a row still showing from the last query", { stale: true }, false, false],
    ["a disabled row", { disabled: true }, false, false],
    ["any row while the list is blocked", {}, true, false],
    ["no row", undefined, false, false],
  ])("%s", (_, row, blocked, expected) => {
    expect(canPick(row, blocked)).toBe(expected);
  });
});
