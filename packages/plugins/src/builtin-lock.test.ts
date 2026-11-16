import { expect, it } from "vitest";
import { nextBuiltinsLock } from "./builtin-lock.ts";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);

it("a built-in whose files change goes up a version and remembers every hash it shipped with", () => {
  const first = nextBuiltinsLock(undefined, { skills: { x: a }, suits: {} });
  const second = nextBuiltinsLock(first, { skills: { x: b }, suits: {} });
  const third = nextBuiltinsLock(second, { skills: { x: c }, suits: {} });
  expect(third.skills.x).toEqual({ version: 3, hash: c, previous: [b, a] });
});

it("an unchanged built-in keeps its version, and one no longer shipped leaves the lock", () => {
  const first = nextBuiltinsLock(undefined, { skills: {}, suits: { tarn: a, ion: b } });
  const second = nextBuiltinsLock(first, { skills: {}, suits: { tarn: a } });
  expect(second.suits).toEqual({ tarn: { version: 1, hash: a, previous: [] } });
});

it("going back to an earlier version's files is a new version that doesn't list itself as old", () => {
  const first = nextBuiltinsLock(undefined, { skills: {}, suits: { tarn: a } });
  const second = nextBuiltinsLock(first, { skills: {}, suits: { tarn: b } });
  const third = nextBuiltinsLock(second, { skills: {}, suits: { tarn: a } });
  expect(third.suits.tarn).toEqual({ version: 3, hash: a, previous: [b] });
});
