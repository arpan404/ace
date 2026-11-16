import { expect, test } from "vitest";
import { z } from "zod";
import {
  SuitLabelKey,
  SuitOrnamentSlot,
  SuitPage,
  SuitPart,
  SuitRegion,
  SuitSceneRegion,
  protectedSuitParts,
  suitPartStates,
} from "@ace/protocol/suit-parts";
import { SuitBase, SuitManifest } from "@ace/protocol/suits";
import { builtinGuides } from "./builtins.ts";

/*
 * The make-a-suit skill teaches the Suit format from prose. These tests hold that prose to the
 * protocol: every file it points to ships, and every field, part, page, state and region it
 * names exists, so a schema change that leaves the skill behind fails here.
 */

async function skill() {
  const guide = (await builtinGuides()).find((entry) => entry.name === "make-a-suit");
  if (!guide) throw new Error("make-a-suit is not shipped");
  return guide;
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);

test("make-a-suit points at every reference file it ships, and each one ships", async () => {
  const { body, files } = await skill();
  const named = new Set(all(body, /`(references\/[a-z-]+\.md)`/g));
  expect([...named].toSorted()).toEqual(Object.keys(files).toSorted());
  for (const content of Object.values(files)) expect(content.trim().length).toBeGreaterThan(200);
});

test("every part, page, state and region the skill names is in the styling contract", async () => {
  const { body, files } = await skill();
  const text = [body, ...Object.values(files)].join("\n");
  const states = new Set<string>(suitPartStates);
  for (const name of all(text, /data-part="([^"]+)"/g))
    expect(SuitPart.safeParse(name).success, `part ${name}`).toBe(true);
  for (const name of all(text, /data-page="([^"]+)"/g))
    expect(SuitPage.safeParse(name).success, `page ${name}`).toBe(true);
  for (const name of all(text, /data-state="([^"]+)"/g))
    expect(states.has(name ?? ""), `state ${name}`).toBe(true);
  for (const name of all(
    text,
    /--suit-([a-z-]+?)-(?:background|border|shadow|backdrop-filter|scene-opacity)\b/g,
  ))
    expect(name === "<region>" || SuitRegion.safeParse(name).success, `region ${name}`).toBe(true);
  // The hard rules name every guarded part, so a new one can't go untaught.
  for (const name of protectedSuitParts) expect(body).toContain(`\`${name}\``);
});

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  propertyNames?: { enum?: string[] };
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  type?: string;
  minimum?: number;
  maximum?: number;
};

/** The schema at a documented path (`layout.sidebar`, `ornaments[].slot`), or undefined. */
function resolve(schema: JsonSchema, path: readonly string[]): JsonSchema | undefined {
  const [head, ...rest] = path;
  if (head === undefined) return schema;
  if (schema.anyOf)
    for (const option of schema.anyOf) {
      const found = resolve(option, path);
      if (found) return found;
    }
  const next =
    head === "[]"
      ? schema.items
      : (schema.properties?.[head] ??
        (schema.propertyNames?.enum?.includes(head) &&
        typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : undefined));
  return next && resolve(next, rest);
}

const leaves = (schema: JsonSchema): JsonSchema[] =>
  schema.anyOf ? schema.anyOf.flatMap(leaves) : [schema];

test("every suit.json field the reference documents exists, with the values and range it says", async () => {
  const { files } = await skill();
  const reference = files["references/suit-json.md"] ?? "";
  const manifest = z.toJSONSchema(SuitManifest, { io: "input", unrepresentable: "any" });
  const rows = reference.split("\n").filter((line) => /^\| `[a-zA-Z]/.test(line));
  expect(rows.length).toBeGreaterThan(60);
  for (const row of rows) {
    const path = /^\| `([^`]+)`/.exec(row)?.[1] ?? "";
    const segments = path.replaceAll("[]", ".[]").split(".");
    const found = resolve(manifest as JsonSchema, segments);
    expect(found, `suit.json has no ${path}`).toBeDefined();
    for (const leaf of leaves(found ?? {})) {
      for (const value of leaf.enum ?? [])
        expect(row, `${path} lists ${String(value)}`).toContain(`\`${String(value)}\``);
      if (leaf.type === "number" && leaf.minimum !== undefined && leaf.maximum !== undefined)
        expect(row, `${path} states its range`).toContain(`${leaf.minimum}–${leaf.maximum}`);
    }
  }
  // Fixed sets documented in prose rather than per row.
  for (const set of [SuitBase, SuitRegion, SuitSceneRegion, SuitOrnamentSlot, SuitLabelKey])
    for (const value of set.options)
      expect(reference.includes(`\`${value}\``) || reference.includes(`.${value}\``), value).toBe(
        true,
      );
});

test("the complete suit.json example is a valid manifest", async () => {
  const { files } = await skill();
  const blocks = all(files["references/suit-json.md"] ?? "", /```json\n([\s\S]*?)```/g);
  const manifests = blocks.filter((block) => block?.includes('"format"'));
  expect(manifests.length).toBeGreaterThan(0);
  for (const block of manifests) {
    const parsed = SuitManifest.safeParse(JSON.parse(block ?? ""));
    expect(parsed.error?.issues ?? []).toEqual([]);
  }
});
