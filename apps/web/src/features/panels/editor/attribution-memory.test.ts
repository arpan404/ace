import { expect, test } from "vitest";
import { deviceAttribution } from "./attribution-memory.ts";

/** Device storage holding at most `quota` characters, as a browser's localStorage refuses. */
function storage(quota = Number.POSITIVE_INFINITY) {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > quota) throw new DOMException("full", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
    size: () => [...items.values()].reduce((sum, value) => sum + value.length, 0),
  };
}

const who = { name: "Claude Code", provider: "claude" as const, turn: 2 };
const saved = (blocks = 1) => ({
  lines: 40,
  blocks: Array.from({ length: blocks }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    at: 1,
    who,
    hash: `h${index}`,
  })),
});

test("a file's lines read back as they were written, with their author", () => {
  const memory = deviceAttribution(storage(), { bytes: 100_000, blocks: 100 });
  memory.write("m1\u0000/repo\u0000a.ts", saved(2));
  expect(memory.read("m1\u0000/repo\u0000a.ts")).toEqual(saved(2));
  expect(memory.read("m1\u0000/other\u0000a.ts")).toBeUndefined();
});

test("past the size bound, the files written longest ago go first", () => {
  const device = storage();
  let clock = 0;
  const memory = deviceAttribution(device, { bytes: 600, blocks: 100 }, () => ++clock);
  for (const name of ["a", "b", "c", "d", "e"]) memory.write(name, saved(2));

  expect(device.size()).toBeLessThanOrEqual(600);
  expect(memory.read("e")).toBeDefined();
  expect(memory.read("a")).toBeUndefined();
});

test("a file with more blocks than the bound is not kept", () => {
  const memory = deviceAttribution(storage(), { bytes: 100_000, blocks: 3 });
  memory.write("a", saved(4));
  expect(memory.read("a")).toBeUndefined();
});

test("a full device keeps the newest file by letting older ones go", () => {
  const device = storage(700);
  let clock = 0;
  const memory = deviceAttribution(device, { bytes: 100_000, blocks: 100 }, () => ++clock);
  for (const name of ["a", "b", "c", "d"]) memory.write(name, saved(2));
  expect(memory.read("d")).toBeDefined();
  expect(device.size()).toBeLessThanOrEqual(700);
});
