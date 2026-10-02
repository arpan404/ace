import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as fc from "fast-check";
import {
  protocolCatalog,
  convertSchemas,
  renderReference,
  checkFiles,
  writeFiles,
  canonical,
  schemaId,
} from "./index.ts";
import { jsonValidator } from "./examples.ts";
import { arbitrary } from "./arbitraries.test-support.ts";

const catalog = protocolCatalog();
const snapshot = convertSchemas(catalog.entries);
const validator = jsonValidator(snapshot);
describe("exported protocol", () => {
  for (const entry of catalog.entries) {
    it(`${entry.name} random wire values validate against its exported schema`, () => {
      const validate = validator.getSchema(schemaId(entry.name));
      if (!validate) throw new Error(`Missing validator for ${entry.name}`);
      // Refined objects need rejection sampling; filtering uses the original validator.
      const values = arbitrary(entry.schema).filter(
        (value) => entry.schema.safeParse(value).success,
      );
      fc.assert(
        fc.property(values, (value) => {
          const wire = entry.io === "output" ? entry.schema.parse(value) : value;
          expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
        }),
        { numRuns: 40, seed: 42, maxSkipsPerRun: 1000 },
      );
    });
  }
});
it("documents every union alternative with examples accepted by both validators", () => {
  const files = renderReference(catalog.entries, catalog.tools, snapshot);
  for (const page of ["commands", "requests", "push", "events", "mcp", "types"]) {
    const markdown = files.get(`${page}.md`);
    expect(markdown).toBeDefined();
    let name = "";
    let total = 0;
    for (const line of markdown?.split(/(?=^## |^```json\n)/m) ?? []) {
      if (line.startsWith("## ")) name = line.split("\n")[0]?.slice(3) ?? "";
      if (!line.startsWith("```json\n")) continue;
      const raw = JSON.parse(line.slice(8).split("\n```")[0] ?? "");
      const entry = catalog.entries.find((item) => item.name === name);
      if (!entry) throw new Error(`No source for example ${name}`);
      expect(entry.schema.safeParse(raw).success).toBe(true);
      expect(validator.getSchema(schemaId(name))?.(raw)).toBe(true);
      total++;
    }
    expect(total).toBeGreaterThan(0);
  }
  expect(files.get("requests.md")).toContain("### hello");
  expect(files.get("events.md")).toContain("### item.delta");
  expect(files.get("README.md")).toContain("protocolVersion");
});
it("keeps ids and references stable regardless of export discovery order", () => {
  expect(canonical(convertSchemas(catalog.entries.toReversed()))).toBe(canonical(snapshot));
  const command = validator.getSchema(schemaId("Command"));
  expect(
    command?.({
      id: "retry",
      deviceId: "device",
      payload: { type: "thread.archive", threadId: "thread" },
    }),
  ).toBe(true);
  expect(
    command?.({
      id: "retry",
      deviceId: "device",
      payload: { type: "thread.archive", threadId: 42 },
    }),
  ).toBe(false);
});
it("distinguishes accepted input defaults from populated MCP output defaults", () => {
  const converted = convertSchemas([
    { name: "Input", schema: z.object({ count: z.number().default(1) }) },
    { name: "Output", schema: z.object({ count: z.number().default(1) }), io: "output" },
  ]);
  const validate = jsonValidator(converted);
  expect(validate.getSchema(schemaId("Input"))?.({})).toBe(true);
  expect(validate.getSchema(schemaId("Output"))?.({})).toBe(false);
  expect(validate.getSchema(schemaId("Output"))?.({ count: 1 })).toBe(true);
});
it("detects missing, stale and unexpected files and regeneration repairs them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-protocol-docs-"));
  try {
    const files = renderReference(catalog.entries, catalog.tools, snapshot);
    expect(await checkFiles(root, files)).toContain("README.md");
    await writeFiles(root, files);
    expect(await checkFiles(root, files)).toEqual([]);
    await writeFile(join(root, "schema", "Command.json"), "stale");
    await writeFile(join(root, "retired.json"), "{}");
    expect(await checkFiles(root, files)).toEqual(["retired.json", "schema/Command.json"]);
    await writeFiles(root, files);
    expect(await checkFiles(root, files)).toEqual([]);
    expect(await readFile(join(root, "schema", "Command.json"), "utf8")).toBe(
      files.get("schema/Command.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  ["Date", z.object({ value: z.date() })],
  ["Transform", z.object({ value: z.string().transform((value) => value.length) })],
  ["Refinement", z.object({ value: z.string().refine((value) => value === "only") })],
  ["Coercion", z.coerce.number()],
  ["BigInt", z.bigint()],
  ["Overwrite", z.string().trim()],
  ["Catch", z.number().catch(1)],
  ["Lazy", z.lazy(() => z.string().refine((value) => value === "only"))],
])("reports the owning schema for unsupported %s", (name, schema) => {
  expect(() => convertSchemas([{ name, schema }])).toThrow(`Schema ${name}:`);
});
it("exports declared semantic rules and rejects invalid examples", () => {
  expect(canonical(snapshot.schemas.ClientMessage)).toContain("Exactly one of token and ticket");
  const impossible = z
    .string()
    .refine(() => false)
    .meta({ "x-ace-constraint": "Impossible value" });
  const entries = [{ name: "Impossible", schema: impossible }];
  expect(() => renderReference(entries, [], convertSchemas(entries))).toThrow(
    "Schema Impossible: no valid example",
  );
});

it("derives ids and the version from matching hello and welcome literals", () => {
  const client = z.union([
    z.object({ type: z.literal("hello"), protocolVersion: z.literal(2) }),
    z.object({ type: z.literal("ping") }),
  ]);
  const server = z.union([
    z.object({ type: z.literal("welcome"), protocolVersion: z.literal(2) }),
    z.object({ type: z.literal("pong") }),
  ]);
  const converted = convertSchemas([
    { name: "ClientMessage", schema: client },
    { name: "ServerMessage", schema: server },
  ]);
  expect(converted.protocolVersion).toBe(2);
  expect(
    jsonValidator(converted).getSchema(schemaId("ClientMessage", 2))?.({
      type: "hello",
      protocolVersion: 2,
    }),
  ).toBe(true);
  expect(() =>
    convertSchemas([
      { name: "ClientMessage", schema: client },
      {
        name: "ServerMessage",
        schema: z.union([
          z.object({ type: z.literal("welcome"), protocolVersion: z.literal(1) }),
          z.object({ type: z.literal("pong") }),
        ]),
      },
    ]),
  ).toThrow("inconsistent protocol versions");
});
