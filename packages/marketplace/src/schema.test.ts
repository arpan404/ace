import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSchema, schemaMisfits } from "./schema.ts";

/**
 * The conformance suite's schema cases (`spade/spec/conformance/contracts/schemas.json`), which
 * Spade's reader runs too (`spade_core::schema`).
 */
const all = JSON.parse(
  readFileSync(
    new URL("../../../spade/spec/conformance/contracts/schemas.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    id: string;
    schema: unknown;
    rule?: string;
    fits?: unknown[];
    misfits?: { value: unknown; at: string }[];
  }[];
};

describe("the schema subset both readers share", () => {
  it.each(all.cases.map((c) => [c.id, c] as const))("%s", (_name, c) => {
    const read = readSchema(c.schema, "input");
    if (c.rule !== undefined) {
      expect(read.problems.map((p) => p.rule)).toContain(c.rule);
      return;
    }
    expect(read.problems).toEqual([]);
    const schema = read.schema!;
    for (const value of c.fits ?? []) expect(schemaMisfits(schema, value, "input")).toEqual([]);
    for (const miss of c.misfits ?? [])
      expect(schemaMisfits(schema, miss.value, "input").map((m) => m.at)).toContain(miss.at);
  });
});
