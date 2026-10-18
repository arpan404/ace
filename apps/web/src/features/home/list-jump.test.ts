import type { HomeRow } from "@ace/ui-core";
import { expect, test } from "vitest";
import { typeAheadIndex } from "./list-focus.ts";
import { holdsJumpModifiers, jumpChords, jumpTargets } from "./list-jump.ts";

const row = (item: HomeRow, phase = "idle") => ({ item, phase });

test("numbers go to thread rows as drawn, skipping headings, Unsent and leaving rows", () => {
  const rows = [
    row({ kind: "pinned-header", count: 1 }),
    row({ kind: "pinned", id: "p1" }),
    row({ kind: "pinned-end" }),
    row({ kind: "unsent" }),
    row({ kind: "thread", id: "gone" }, "exit"),
    row({ kind: "thread", id: "t1" }),
    row({ kind: "settled-header", count: 1 }),
    row({ kind: "settled", id: "s1" }),
  ];
  expect(jumpTargets(rows)).toEqual(["p1", "t1", "s1"]);
});

test("only the first nine threads get a number", () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    row({ kind: "thread", id: `t${index + 1}` }),
  );
  expect(jumpTargets(rows)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
});

test("one binding spells all nine jump keys", () => {
  expect(jumpChords("alt+mod+1")).toEqual([
    "alt+mod+1",
    "alt+mod+2",
    "alt+mod+3",
    "alt+mod+4",
    "alt+mod+5",
    "alt+mod+6",
    "alt+mod+7",
    "alt+mod+8",
    "alt+mod+9",
  ]);
});

const press = (init: Partial<KeyboardEvent>) => ({
  key: "Meta",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

test("the numbers show only while exactly the jump modifiers are held", () => {
  expect(holdsJumpModifiers(press({ metaKey: true }), "mod+1", true)).toBe(true);
  expect(holdsJumpModifiers(press({ metaKey: true, shiftKey: true }), "mod+1", true)).toBe(false);
  expect(holdsJumpModifiers(press({ key: "a", metaKey: true }), "mod+1", true)).toBe(false);
  expect(holdsJumpModifiers(press({ metaKey: true }), "alt+mod+1", true)).toBe(false);
  expect(
    holdsJumpModifiers(press({ key: "Alt", metaKey: true, altKey: true }), "alt+mod+1", true),
  ).toBe(true);
  // Off Apple platforms Ctrl is "mod".
  expect(holdsJumpModifiers(press({ key: "Control", ctrlKey: true }), "mod+1", false)).toBe(true);
});

test("type to jump finds the next title with the letter, wrapping round past the end", () => {
  const titles = ["Alpha", undefined, "Beta", "apple", "Bravo"];
  expect(typeAheadIndex(titles, 0, "b")).toBe(2);
  expect(typeAheadIndex(titles, 2, "B")).toBe(4);
  expect(typeAheadIndex(titles, 3, "a")).toBe(0);
  expect(typeAheadIndex(titles, 0, "z")).toBeUndefined();
});
