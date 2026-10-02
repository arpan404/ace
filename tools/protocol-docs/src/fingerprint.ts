import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonical, type Snapshot, type ToolEntry } from "./model.ts";
import { checkFiles } from "./files.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  input: digest,
  files: z.record(
    z.string().regex(/^(?:schema\/)?[A-Za-z][A-Za-z0-9_.]*\.(?:md|json)$/),
    z.strictObject({
      sha256: digest,
      bytes: z
        .number()
        .int()
        .min(0)
        .max(8 * 1024 * 1024),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;
const manifestName = "manifest.json";

/** Include implementation and dependencies so a renderer change cannot reuse old outputs. */
export async function sourceFingerprint(
  root: string,
  snapshot: Snapshot,
  tools: ToolEntry[],
): Promise<string> {
  const files = [
    "bun.lock",
    "tools/protocol-docs/package.json",
    "packages/mcp-server/src/catalog.ts",
  ];
  for (const dir of ["tools/protocol-docs/src", "packages/protocol/src"]) {
    for (const name of await readdir(join(root, dir))) {
      if (name.endsWith(".ts") && !name.includes(".test")) files.push(`${dir}/${name}`);
    }
  }
  if (files.length > 512) throw new Error("Fingerprint source count exceeds 512");
  const sources: [string, string][] = [];
  // Small fixed batches avoid unbounded file-descriptor fan-out.
  const sorted = files.toSorted();
  for (let offset = 0; offset < sorted.length; offset += 8) {
    const batch = await Promise.all(
      sorted.slice(offset, offset + 8).map(async (name): Promise<[string, string]> => {
        const path = join(root, name);
        if ((await stat(path)).size > 2 * 1024 * 1024)
          throw new Error(`Fingerprint source exceeds 2 MiB: ${name}`);
        return [name, hash((await readFile(path, "utf8")).replaceAll("\r\n", "\n"))];
      }),
    );
    sources.push(...batch);
  }
  return hash(canonical({ snapshot, tools, sources }));
}
export function withManifest(files: Map<string, string>, input: string): Map<string, string> {
  const output = new Map(files);
  if (files.has(manifestName)) throw new Error("Manifest name is reserved");
  const manifest = manifestSchema.parse({
    version: 1,
    input,
    files: Object.fromEntries(
      [...files].map(([name, content]) => [
        name,
        { sha256: hash(content), bytes: Buffer.byteLength(content) },
      ]),
    ),
  });
  output.set(manifestName, canonical(manifest));
  return output;
}
export async function checkFingerprint(root: string, input: string): Promise<string[]> {
  const path = join(root, manifestName);
  let manifest: Manifest;
  try {
    if ((await stat(path)).size > 256 * 1024) return [manifestName];
    manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [manifestName];
  }
  if (manifest.input !== input) return [manifestName];
  if (Object.keys(manifest.files).length > 2048 || manifestName in manifest.files)
    return [manifestName];
  // Reuse the file inventory and bounded byte comparator, substituting a digest checker.
  return checkFiles(root, new Map([[manifestName, canonical(manifest)]]), manifest.files);
}
