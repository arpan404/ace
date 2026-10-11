import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CursorAuthEvent, ProjectIcon } from "@ace/protocol";
import * as fc from "fast-check";
import {
  protocolCatalog,
  convertSchemas,
  renderReference,
  checkFiles,
  writeFiles,
  canonical,
  schemaId,
  jsonValidator,
} from "./index.ts";
import { arbitrary } from "./arbitraries.test-support.ts";

const catalog = protocolCatalog();
const snapshot = convertSchemas(catalog.entries);
const validator = jsonValidator(snapshot);
const reference = renderReference(catalog.entries, catalog.tools, snapshot);
describe("exported protocol", () => {
  for (const entry of catalog.entries) {
    it(`${entry.name} random wire values validate against its exported schema`, () => {
      const validate = validator.getSchema(schemaId(entry.name));
      if (!validate) throw new Error(`Missing validator for ${entry.name}`);
      if (entry.schema.meta()?.["x-ace-transport"] === "binary") {
        expect(entry.schema.safeParse(new Uint8Array([0, 255])).success).toBe(true);
        fc.assert(
          fc.property(fc.jsonValue(), (value) => {
            expect(entry.schema.safeParse(value).success).toBe(false);
            expect(validate(value)).toBe(false);
          }),
          { numRuns: 40, seed: 42 },
        );
        return;
      }
      // Refined objects need rejection sampling; filtering uses the original validator.
      const values = arbitrary(entry.schema).filter(
        (value) => entry.schema.safeParse(value).success,
      );
      const witnesses: unknown[] = [null, true, false, 42, 0.125, "", [], {}];
      for (const witness of witnesses)
        if (!entry.schema.safeParse(witness).success)
          expect(validate(witness), `${entry.name} rejects ${JSON.stringify(witness)}`).toBe(false);
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
it("documents every source union alternative with a validated example", () => {
  const files = reference;
  const examples = new Map<string, unknown[]>();
  for (const [file, markdown] of files) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    let name = "";
    let total = 0;
    for (const block of markdown.split(/(?=^## |^```json\n)/m)) {
      if (block.startsWith("## ")) name = block.split("\n")[0]?.slice(3) ?? "";
      if (!block.startsWith("```json\n")) continue;
      const value: unknown = JSON.parse(block.slice(8).split("\n```")[0] ?? "");
      const entry = catalog.entries.find((item) => item.name === name);
      if (!entry) throw new Error(`No source for example ${name}`);
      expect(entry.schema.safeParse(value).success, `${file}: ${name}`).toBe(true);
      expect(validator.getSchema(schemaId(name))?.(value), `${file}: ${name}`).toBe(true);
      const observed = examples.get(name) ?? [];
      observed.push(value);
      examples.set(name, observed);
      total++;
    }
    expect(total, `${file} has validated examples`).toBeGreaterThan(0);
  }
  for (const entry of catalog.entries) {
    if (entry.schema.meta()?.["x-ace-transport"] === "binary") {
      expect(files.get("types.md")).toContain(`## ${entry.name}`);
      expect(files.get("types.md")).toContain("No JSON value is accepted");
      continue;
    }
    const alternatives = entry.schema instanceof z.ZodUnion ? entry.schema.options : [entry.schema];
    const documented = examples.get(entry.name) ?? [];
    expect(documented.length, entry.name).toBeGreaterThanOrEqual(alternatives.length);
    for (const [index, alternative] of alternatives.entries()) {
      if (!(alternative instanceof z.ZodType)) throw new Error("Non-classic source alternative");
      expect(
        documented.some((value) => alternative.safeParse(value).success),
        `${entry.name} alternative ${index}`,
      ).toBe(true);
    }
  }
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
    const files = new Map([
      ["README.md", "Generated reference\n"],
      ["schema/Command.json", canonical(snapshot.schemas.Command)],
    ]);
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
  ["PropertyCheck", z.object({ field: z.string() }).check(z.property("field", z.string().min(2)))],
  ["CustomFormat", z.stringFormat("special", (value) => value === "special")],
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

it("Cursor browser login preserves an HTTPS challenge exactly and rejects whitespace without throwing", () => {
  const event = {
    type: "cursor.auth.login",
    requestId: "request",
    loginId: "login",
    instanceId: "account",
    state: "browser",
    expiresAt: 1000,
  };
  const url = "https://cursor.com/login?challenge=synthetic%20challenge";
  expect(CursorAuthEvent.parse({ ...event, url })).toMatchObject({ url });
  for (const invalid of [
    `${url} `,
    `${url}\n`,
    ` ${url}`,
    "https://cursor.com/\tchallenge",
    "http://cursor.com/login",
    "file:///tmp/login",
    "javascript:alert(1)",
    "https:/login",
    "https://",
  ]) {
    expect(CursorAuthEvent.safeParse({ ...event, url: invalid }).success).toBe(false);
  }
});

it("project icon JSON schemas preserve case-insensitive HTTP schemes without permitting other schemes or oversized uploads", () => {
  const validate = validator.getSchema(schemaId("ProjectIcon"));
  if (!validate) throw new Error("Missing icon validator");
  for (const value of [
    "http://example.test/icon.png",
    "HTTPS://example.test/icon.png",
    "hTtPs://example.test/icon.png",
    "HTTPS://例え.テスト/icon.png",
    "data:image/png;base64,YQ==",
  ]) {
    expect(ProjectIcon.safeParse(value).success, value).toBe(true);
    expect(validate(value), value).toBe(true);
  }
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/icon.png",
    "ftp://example.test/icon.png",
    "data:image/svg+xml;base64,YQ==",
    `https://example.test/${"x".repeat(4096)}`,
    `data:image/png;base64,${"AAAA".repeat(32768)}`,
  ]) {
    expect(ProjectIcon.safeParse(value).success).toBe(false);
    expect(validate(value)).toBe(false);
  }
});

it("project icon normalization inputs reject without safeParse throwing and valid mixed-case URLs stay unchanged", () => {
  const validate = validator.getSchema(schemaId("ProjectIcon"));
  if (!validate) throw new Error("Missing icon validator");
  for (const value of [
    "https://example.test/icon.png\n",
    "https://exa\tmple.test/icon.png",
    "https://example.test/icon.png ",
    " https://example.test/icon.png",
    "https://example.test/icon.png\u2028",
    "https://",
  ]) {
    expect(() => ProjectIcon.safeParse(value)).not.toThrow();
    expect(ProjectIcon.safeParse(value).success).toBe(false);
    expect(validate(value)).toBe(false);
  }
  for (const value of ["hTtPs://example.test/icon.png", "HTTPS://例え.テスト/icon.png"])
    expect(ProjectIcon.parse(value)).toBe(value);
});
