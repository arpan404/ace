import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compareSnapshots,
  convertSchemas,
  parseSnapshot,
  schemaId,
  type Snapshot,
  type JsonSchema,
} from "./index.ts";

const snapshot = (schema: z.ZodType) => convertSchemas([{ name: "Message", schema }]);
const compare = (before: z.ZodType, after: z.ZodType) =>
  compareSnapshots(snapshot(before), snapshot(after));
const rejected = (before: z.ZodType, after: z.ZodType) =>
  compare(before, after).some((change) => change.kind !== "additive");
const raw = (value: JsonSchema): Snapshot => ({
  protocolVersion: 1,
  schemas: { Message: { $id: schemaId("Message"), ...value } },
});

describe("release compatibility", () => {
  it("accepts optional additions, wider enums and wider number bounds", () => {
    const before = z.object({ state: z.enum(["working", "done"]), count: z.number().max(10) });
    const after = z.object({
      state: z.enum(["working", "done", "waiting"]),
      count: z.number().max(20),
      label: z.string().optional(),
    });
    expect(rejected(before, after)).toBe(false);
    expect(compare(before, after)).toContainEqual(
      expect.objectContaining({ kind: "additive", path: "$/label", reason: "Field added" }),
    );
  });
  it("reports a removed field even when it was optional", () => {
    expect(compare(z.object({ label: z.string().optional() }), z.object({}))).toContainEqual(
      expect.objectContaining({ kind: "breaking", path: "$/label", reason: "Field removed" }),
    );
  });
  it("reports required additions and fields becoming required", () => {
    expect(rejected(z.object({}), z.object({ label: z.string() }))).toBe(true);
    expect(
      compare(z.object({ label: z.string().optional() }), z.object({ label: z.string() })),
    ).toContainEqual(
      expect.objectContaining({
        kind: "breaking",
        path: "$/label",
        reason: "Field became required",
      }),
    );
  });
  it("reports a field rename as removal plus addition", () => {
    const changes = compare(z.object({ oldName: z.string() }), z.object({ newName: z.string() }));
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: "breaking", path: "$/oldName" }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: "additive", path: "$/newName" }),
    );
  });
  it("reports schema rename and deletion", () => {
    const changes = compareSnapshots(
      snapshot(z.string()),
      convertSchemas([{ name: "Renamed", schema: z.string() }]),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "breaking",
        schema: "Message",
        reason: "Schema removed or renamed",
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: "additive", schema: "Renamed" }),
    );
  });
  it.each([
    ["number to integer", z.number(), z.number().int()],
    ["unknown to string", z.unknown(), z.string()],
    ["nullable to string", z.string().nullable(), z.string()],
    ["enum removal", z.enum(["a", "b"]), z.enum(["a"])],
    ["higher minimum", z.number().min(1), z.number().min(2)],
    ["lower maximum", z.number().max(10), z.number().max(9)],
    ["longer minimum string", z.string().min(1), z.string().min(2)],
    ["shorter maximum string", z.string().max(10), z.string().max(9)],
    ["narrower array", z.array(z.number()), z.array(z.number().int())],
    ["larger array minimum", z.array(z.string()), z.array(z.string()).min(1)],
    ["strict object", z.object({}), z.strictObject({})],
    ["narrower record", z.record(z.string(), z.number()), z.record(z.string(), z.number().int())],
  ])("rejects %s", (_, before, after) => expect(rejected(before, after)).toBe(true));
  it("accepts integer to number, optional requiredness and nullable widening", () => {
    expect(rejected(z.number().int(), z.number())).toBe(false);
    expect(
      rejected(z.object({ label: z.string() }), z.object({ label: z.string().optional() })),
    ).toBe(false);
    expect(rejected(z.string(), z.string().nullable())).toBe(false);
  });
  it("accepts reordered unions and new message variants but rejects narrowed variants", () => {
    const a = z.object({ type: z.literal("a"), text: z.string() });
    const b = z.object({ type: z.literal("b"), count: z.number() });
    const c = z.object({ type: z.literal("c") });
    expect(rejected(z.union([a, b]), z.union([b, c, a]))).toBe(false);
    expect(rejected(z.union([a, b]), z.union([a, b.extend({ count: z.number().int() })]))).toBe(
      true,
    );
    expect(rejected(z.union([a, b]), a)).toBe(true);
  });
  it("detects a changed target behind unchanged reference strings", () => {
    const previous = convertSchemas([
      { name: "Id", schema: z.string() },
      { name: "Message", schema: z.object({ id: z.string() }) },
    ]);
    const current = convertSchemas([
      { name: "Id", schema: z.string().min(2) },
      { name: "Message", schema: z.object({ id: z.string() }) },
    ]);
    for (const state of [previous, current])
      state.schemas.Message = {
        $id: schemaId("Message"),
        type: "object",
        properties: { id: { $ref: schemaId("Id") } },
        required: ["id"],
      };
    expect(compareSnapshots(previous, current)).toContainEqual(
      expect.objectContaining({ schema: "Message", path: "$/id", kind: "breaking" }),
    );
  });
  it("requires review for changed patterns, defaults or semantic rules", () => {
    expect(compare(z.string().regex(/^a/), z.string().regex(/^b/))).toContainEqual(
      expect.objectContaining({ kind: "review", reason: "Validation keyword pattern changed" }),
    );
    expect(compare(z.number().default(1), z.number().default(2))).toContainEqual(
      expect.objectContaining({ kind: "review", reason: "Validation keyword default changed" }),
    );
    expect(
      compare(
        z.string().meta({ "x-ace-constraint": "rule a" }),
        z.string().meta({ "x-ace-constraint": "rule b" }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "review",
        reason: "Validation keyword x-ace-constraint changed",
      }),
    );
  });
  it("ignores description changes and compares protocol versions", () => {
    expect(compare(z.string().describe("old"), z.string().describe("new"))).toEqual([]);
    const current = snapshot(z.string());
    expect(compareSnapshots(current, { ...current, protocolVersion: 2 })).toContainEqual(
      expect.objectContaining({ schema: "protocol", kind: "breaking" }),
    );
  });
  it("validates release snapshots before comparing them", () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot(z.string()))))).toEqual(
      snapshot(z.string()),
    );
    expect(() => parseSnapshot({ protocolVersion: "1", schemas: {} })).toThrow();
    expect(() =>
      parseSnapshot({
        protocolVersion: 1,
        schemas: { Bad: { type: "garbage", $id: "https://example.invalid/Bad" } },
      }),
    ).toThrow();
    expect(() =>
      parseSnapshot({
        protocolVersion: 1,
        schemas: { Bad: { $id: "https://example.invalid/Bad", $ref: "https://missing.invalid" } },
      }),
    ).toThrow();
  });
  it("rejects unknown keyword changes instead of declaring them additive", () => {
    expect(
      compareSnapshots(raw({ type: "array" }), raw({ type: "array", uniqueItems: true })),
    ).toContainEqual(expect.objectContaining({ kind: "review" }));
  });
});

it("rejects newly forbidden array items and constraints alongside unions", () => {
  expect(
    compareSnapshots(
      raw({ type: "array", items: true }),
      raw({ type: "array", items: false }),
    ).some((change) => change.kind !== "additive"),
  ).toBe(true);
  expect(
    compareSnapshots(
      raw({ type: "number" }),
      raw({ minimum: 10, anyOf: [{ type: "number" }, { type: "integer" }] }),
    ).some((change) => change.kind !== "additive"),
  ).toBe(true);
});
it("keeps validation siblings on references as intersections", () => {
  const before = {
    protocolVersion: 1,
    schemas: {
      Target: { $id: schemaId("Target"), type: "number", minimum: 2 },
      Message: { $id: schemaId("Message"), $ref: schemaId("Target"), minimum: 1 },
    },
  } satisfies Snapshot;
  const after = {
    ...before,
    schemas: { ...before.schemas, Target: { ...before.schemas.Target, minimum: 3 } },
  };
  expect(compareSnapshots(before, after)).toContainEqual(
    expect.objectContaining({ schema: "Message", kind: "breaking" }),
  );
});
