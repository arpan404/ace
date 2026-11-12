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

test("arrays, class instances and primitives read as empty, and plain objects without a prototype as themselves", () => {
  const bare = Object.assign(Object.create(null), { a: 1 });
  for (const value of [[1], new Map([["a", 1]]), new Date(0), "text", 3, null, undefined])
    expect(nativeRecord(value)).toStrictEqual(zodRecord(value));
  // zod copied it onto Object.prototype; the fields read the same.
  expect(nativeRecord(bare)).toBe(bare);
  expect(nativeRecord(bare)).toEqual(zodRecord(bare));
});
