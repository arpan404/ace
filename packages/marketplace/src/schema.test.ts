import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSchema, schemaMisfits } from "./schema.ts";

/** The schema cases Spade's reader runs too (`spade_core::schema`, schema/tests.rs). */
const all = JSON.parse(
  readFileSync(
    new URL("../../../spade/crates/spade-core/src/schema/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    name: string;
    schema: unknown;
    refused?: string;
    fits?: unknown[];
    misfits?: { value: unknown; at: string }[];
  }[];
};

describe("the schema subset both readers share", () => {
  it.each(all.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const read = readSchema(c.schema, "input");
    if (c.refused !== undefined) {
      expect(read.problems.some((p) => p.includes(c.refused!))).toBe(true);
      return;
    }
    expect(read.problems).toEqual([]);
    const schema = read.schema!;
    for (const value of c.fits ?? []) expect(schemaMisfits(schema, value, "input")).toEqual([]);
    for (const miss of c.misfits ?? [])
      expect(schemaMisfits(schema, miss.value, "input").map((m) => m.at)).toContain(miss.at);
  });
});
