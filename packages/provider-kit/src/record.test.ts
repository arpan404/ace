import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { nativeRecord } from "./record.ts";

/** What the adapters' record helpers returned before: zod's record parse, or an empty object. */
const zodRecord = (value: unknown) => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
};

function recordedValues(): unknown[] {
  const root = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const values: unknown[] = [];
  const visit = (value: unknown) => {
    values.push(value);
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) visit(child);
  };
  for (const file of files)
    for (const line of readFileSync(join(root, file), "utf8").split("\n"))
      if (line.trim()) visit(JSON.parse(line));
  return values;
}

test("every value in the recorded provider sessions reads as the zod record parse read it", () => {
  const values = recordedValues();
  expect(values.length).toBeGreaterThan(10_000);
  for (const value of values) expect(nativeRecord(value)).toStrictEqual(zodRecord(value));
});

test("arrays, Maps, Dates and primitives read as empty, as zod's record parse read them", () => {
  for (const value of [[1], new Map([["a", 1]]), new Date(0), "text", 3, null, undefined])
    expect(nativeRecord(value)).toStrictEqual(zodRecord(value));
});

test("a plain object is read whole and as itself, never copied", () => {
  const symbol = Symbol("native");
  const hidden = Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false });
  const proto: unknown = JSON.parse('{"__proto__":{"x":1},"a":2}');
  const bare = Object.assign(Object.create(null), { a: 1 });
  for (const value of [{ [symbol]: 1, a: 2 }, hidden, proto, bare])
    expect(nativeRecord(value)).toBe(value);
  // zod refused a symbol key and dropped non-enumerable fields and own __proto__ fields.
  expect(Reflect.get(nativeRecord({ [symbol]: 1 }), symbol)).toBe(1);
  expect(nativeRecord(hidden)["hidden"]).toBe(2);
  expect(Object.hasOwn(nativeRecord(proto), "__proto__")).toBe(true);
});

test("a class instance reads as empty, whatever its own fields", () => {
  class Native {
    a = 1;
    constructor() {
      // zod treated an own undefined constructor as plain and copied the fields.
      Object.defineProperty(this, "constructor", { value: undefined, enumerable: false });
    }
  }
  expect(nativeRecord(new Native())).toStrictEqual({});
  expect(Object.isFrozen(nativeRecord(new Native()))).toBe(true);
});
