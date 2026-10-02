import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { z } from "zod";
import { PairingResponse, ConductorModel, OrchestrationBudget } from "@ace/protocol";
import {
  checkFiles,
  writeFiles,
  compareSnapshots,
  convertSchemas,
  schemaId,
  jsonValidator,
  parseSnapshot,
  checkFingerprint,
  type Snapshot,
} from "./index.ts";

it("refuses a symlink output root without changing or deleting target files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-docs-boundary-"));
  const target = join(directory, "target");
  const root = join(directory, "protocol");
  try {
    await mkdir(target);
    await writeFile(join(target, "sentinel.txt"), "keep sentinel");
    await writeFile(join(target, "README.md"), "keep existing reference");
    await symlink(target, root, "dir");
    const files = new Map([["README.md", "replacement"]]);
    await expect(writeFiles(root, files)).rejects.toThrow(/symlink/);
    await expect(checkFiles(root, files)).rejects.toThrow(/symlink/);
    await expect(checkFingerprint(root, "1".repeat(64))).rejects.toThrow(/symlink/);
    expect(await readFile(join(target, "sentinel.txt"), "utf8")).toBe("keep sentinel");
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("keep existing reference");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["toString", "constructor", "hasOwnProperty", "__proto__"])(
  "reports removal of the optional field %s despite inherited object members",
  (name) => {
    const previous = {
      protocolVersion: 1,
      schemas: {
        Message: {
          $id: schemaId("Message"),
          type: "object",
          properties: { [name]: { type: "string" } },
        },
      },
    } satisfies Snapshot;
    const current = {
      protocolVersion: 1,
      schemas: { Message: { $id: schemaId("Message"), type: "object" } },
    } satisfies Snapshot;
    expect(compareSnapshots(previous, current)).toContainEqual(
      expect.objectContaining({ kind: "breaking", path: `$/${name}`, reason: "Field removed" }),
    );
  },
);

it.each(["toString", "constructor", "hasOwnProperty"])(
  "reports removal of export %s despite inherited object members",
  (name) => {
    const previous = parseSnapshot(
      JSON.parse(JSON.stringify(convertSchemas([{ name, schema: z.string() }]))),
    );
    const current = convertSchemas([]);
    expect(compareSnapshots(previous, current)).toContainEqual(
      expect.objectContaining({
        kind: "breaking",
        schema: name,
        reason: "Schema removed or renamed",
      }),
    );
  },
);

it.each([
  " https://example.com/ ",
  "\u00a0https://example.com/\u00a0",
  "https://例え.テスト/道",
  "http:example.com",
  "https://exa\nmple.com/",
  "mailto:client@example.invalid",
  "file:///tmp/example",
  "ace:thread/1",
])("accepts the same WHATWG pairing URL input as Zod: %s", (url) => {
  const value = { url, expiresAt: 0 };
  expect(PairingResponse.safeParse(value).success).toBe(true);
  const snapshot = convertSchemas([{ name: "PairingResponse", schema: PairingResponse }]);
  const validate = jsonValidator(snapshot).getSchema(schemaId("PairingResponse"));
  expect(validate?.(value)).toBe(true);
});

it("rejects attached function-backed formats with the owning schema name", () => {
  const source = z
    .string()
    .check(z.stringFormat("email", (value) => value === "client@example.invalid"));
  expect(() =>
    convertSchemas([{ name: "AttachedFormat", schema: z.object({ email: source }) }]),
  ).toThrow(/Schema AttachedFormat:.*custom string format/);
});

it.each(["", "not a url", "/relative/path", "https://", "http://[invalid]"])(
  "rejects malformed pairing URL input: %s",
  (url) => {
    const value = { url, expiresAt: 0 };
    const snapshot = convertSchemas([{ name: "PairingResponse", schema: PairingResponse }]);
    expect(PairingResponse.safeParse(value).success).toBe(false);
    expect(jsonValidator(snapshot).getSchema(schemaId("PairingResponse"))?.(value)).toBe(false);
  },
);

it("preserves WHATWG URL acceptance for attached built-in URL checks", () => {
  const source = z.string().check(z.url());
  const value = " http:example.com ";
  expect(source.safeParse(value).success).toBe(true);
  const snapshot = convertSchemas([{ name: "AttachedUrl", schema: source }]);
  expect(jsonValidator(snapshot).getSchema(schemaId("AttachedUrl"))?.(value)).toBe(true);
});

it.each([
  z.url({ hostname: /^example\.com$/ }),
  z.url({ normalize: true }),
  z.url().regex(/example/),
])("reports URL parsing options or post-normalization checks it cannot export", (source) => {
  expect(() => convertSchemas([{ name: "SpecialUrl", schema: source }])).toThrow(
    /Schema SpecialUrl: Unsupported URL/,
  );
});

it("refuses an intermediate symlink beneath the caller's owned boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-docs-parent-"));
  try {
    const target = join(directory, "target");
    await mkdir(target);
    await writeFile(join(target, "sentinel.txt"), "keep");
    await symlink(target, join(directory, "docs"), "dir");
    await expect(
      writeFiles(
        join(directory, "docs", "protocol"),
        new Map([["README.md", "replacement"]]),
        directory,
      ),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(join(target, "sentinel.txt"), "utf8")).toBe("keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { provider: "claude", model: "example", tier: "normal", cost: 0.125, quota: 0.5 },
  { provider: "claude", model: "example", tier: "normal", cost: 0, quota: Number.MIN_VALUE },
])("keeps fractional costs, positive subnormals and zero cost on the wire", (value) => {
  expect(ConductorModel.safeParse(value).success).toBe(true);
  const snapshot = convertSchemas([{ name: "ConductorModel", schema: ConductorModel }]);
  expect(jsonValidator(snapshot).getSchema(schemaId("ConductorModel"))?.(value)).toBe(true);
});

it("preserves fractional orchestration budgets and rejects their invalid bounds", () => {
  const snapshot = convertSchemas([{ name: "OrchestrationBudget", schema: OrchestrationBudget }]);
  const validate = jsonValidator(snapshot).getSchema(schemaId("OrchestrationBudget"));
  const valid = {
    maxLanes: 64,
    maxDepth: 8,
    maxAttempts: 10,
    tokens: Number.MAX_SAFE_INTEGER,
    cost: 0.125,
    durationMs: Number.MAX_SAFE_INTEGER,
  };
  expect(OrchestrationBudget.safeParse(valid).success).toBe(true);
  expect(validate?.(valid)).toBe(true);
  for (const invalid of [
    { ...valid, maxLanes: 65 },
    { ...valid, maxDepth: -1 },
    { ...valid, cost: -0.125 },
    { ...valid, maxLanes: 1.5 },
  ]) {
    expect(OrchestrationBudget.safeParse(invalid).success).toBe(false);
    expect(validate?.(invalid)).toBe(false);
  }
});

it("applies URL length limits after the same normalization as the wire parser", () => {
  const source = z.url().max(30);
  const snapshot = convertSchemas([{ name: "BoundedUrl", schema: source }]);
  const validate = jsonValidator(snapshot).getSchema(schemaId("BoundedUrl"));
  for (const value of [
    " ".repeat(40) + "https://example.com/" + " ".repeat(40),
    "https://exa\tmple.com/",
    "https://example.com/" + "x".repeat(40),
  ])
    expect(validate?.(value)).toBe(source.safeParse(value).success);
  expect(validate?.("https://example.com/" + "x".repeat(40))).toBe(false);
});

it("rejects escaping roots and unsafe output names before touching existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-docs-paths-"));
  try {
    const root = join(directory, "protocol");
    await mkdir(root);
    await writeFile(join(root, "README.md"), "keep reference");
    await expect(
      writeFiles(
        root,
        new Map([
          ["README.md", "replace"],
          ["../escape.json", "{}"],
        ]),
      ),
    ).rejects.toThrow(/Invalid output path/);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("keep reference");
    await expect(writeFiles(directory, new Map([["README.md", "replace"]]), root)).rejects.toThrow(
      /owned boundary/,
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("keep reference");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
