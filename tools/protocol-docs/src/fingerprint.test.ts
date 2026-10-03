import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  checkFingerprint,
  sourceFingerprint,
  withManifest,
  writeFiles,
  convertSchemas,
} from "./index.ts";

it("fast drift checks reject changed, missing and unexpected artifacts and changed inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-protocol-fingerprint-"));
  const input = "1".repeat(64);
  const files = withManifest(
    new Map([
      ["README.md", "Reference\n"],
      ["schema/Example.json", "{}\n"],
    ]),
    input,
  );
  try {
    await writeFiles(root, files);
    expect(await checkFingerprint(root, input)).toEqual([]);
    await writeFile(join(root, "README.md"), "RefereNce\n");
    await writeFile(join(root, "extra.json"), "{}");
    await rm(join(root, "schema", "Example.json"));
    expect(await checkFingerprint(root, input)).toEqual([
      "README.md",
      "extra.json",
      "schema/Example.json",
    ]);
    expect(await checkFingerprint(root, "2".repeat(64))).toEqual(["manifest.json"]);
    await writeFiles(root, files);
    expect(await checkFingerprint(root, input)).toEqual([]);
    await writeFile(join(root, "manifest.json"), "{}");
    expect(await checkFingerprint(root, input)).toEqual(["manifest.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("source changes, schema changes and toolkit metadata invalidate the generated fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-protocol-sources-"));
  const sources = [
    "bun.lock",
    "packages/protocol/package.json",
    "tools/protocol-docs/package.json",
    "tools/protocol-docs/src/render.ts",
    "packages/protocol/src/wire.ts",
    "packages/mcp-server/src/catalog.ts",
  ];
  try {
    // This case varies fingerprint inputs, using the real public export manifest.
    const protocolManifest = await readFile(
      new URL("../../../packages/protocol/package.json", import.meta.url),
      "utf8",
    );
    for (const name of sources) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(
        join(root, name),
        name === "packages/protocol/package.json" ? protocolManifest : "source\n",
      );
    }
    const snapshot = convertSchemas([{ name: "Example", schema: z.string() }]);
    const original = await sourceFingerprint(root, snapshot, []);
    await writeFile(join(root, "tools/protocol-docs/src/render.ts"), "changed renderer\n");
    expect(await sourceFingerprint(root, snapshot, [])).not.toBe(original);
    await writeFile(join(root, "tools/protocol-docs/src/render.ts"), "source\n");
    await writeFile(join(root, "packages/protocol/src/wire.ts"), "changed semantic refinement\n");
    expect(await sourceFingerprint(root, snapshot, [])).not.toBe(original);
    await writeFile(join(root, "packages/protocol/src/wire.ts"), "source\n");
    expect(
      await sourceFingerprint(root, convertSchemas([{ name: "Example", schema: z.number() }]), []),
    ).not.toBe(original);
    expect(
      await sourceFingerprint(root, snapshot, [
        {
          name: "ace_example",
          description: "Changed",
          capability: null,
          timeoutMs: 1,
          input: "Example",
          output: "Example",
        },
      ]),
    ).not.toBe(original);
    expect(await sourceFingerprint(root, snapshot, [])).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fingerprints exact artifact bytes, including malformed UTF-8 of the same length", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-protocol-bytes-"));
  const input = "1".repeat(64);
  try {
    await writeFiles(root, withManifest(new Map([["README.md", "\uFFFD"]]), input));
    expect(await checkFingerprint(root, input)).toEqual([]);
    await writeFile(join(root, "README.md"), Buffer.from([0xf0, 0x9f, 0x98]));
    expect(await checkFingerprint(root, input)).toEqual(["README.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses undocumented public protocol entry points before accepting a fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-protocol-entries-"));
  try {
    await mkdir(join(root, "packages/protocol"), { recursive: true });
    await writeFile(
      join(root, "packages/protocol/package.json"),
      JSON.stringify({
        exports: {
          ".": "./src/index.ts",
          "./forge": "./src/forge.ts",
          "./future": "./src/future.ts",
        },
      }),
    );
    await expect(sourceFingerprint(root, convertSchemas([]), [])).rejects.toThrow(
      /Undocumented protocol entry point .\/future/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
