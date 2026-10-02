import { mkdir, readdir, unlink, writeFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dictionary, type Snapshot, type JsonSchema } from "./model.ts";
import { jsonValidator } from "./examples.ts";
import { ownedOutputRoot } from "./output-boundary.ts";

async function paths(root: string, relative = ""): Promise<string[]> {
  if (relative.split("/").length > 8) throw new Error("Generated output depth exceeds 8");
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in generated output: ${name}`);
    if (entry.isDirectory()) result.push(...(await paths(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unexpected non-file output: ${name}`);
    if (result.length > 2048) throw new Error("Generated file count exceeds 2048");
  }
  return result.toSorted();
}
async function matches(
  path: string,
  expected: { bytes: number; accepts(content: Buffer): boolean },
): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const length = expected.bytes;
    if ((await handle.stat()).size !== length) return false;
    const bytes = Buffer.alloc(length + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total === length && expected.accepts(bytes.subarray(0, total));
  } finally {
    await handle.close();
  }
}
async function forFiles<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await run(item);
      }
    }),
  );
}
export async function checkFiles(
  root: string,
  expected: Map<string, string>,
  fingerprints: Record<string, { sha256: string; bytes: number }> = {},
  boundary = dirname(root),
): Promise<string[]> {
  root = await ownedOutputRoot(root, boundary);
  const actual = new Set(await paths(root));
  const stale: string[] = [];
  const checks = [
    ...[...expected].map(([name, content]) => ({
      name,
      bytes: Buffer.byteLength(content),
      accepts: (value: Buffer) => value.equals(Buffer.from(content)),
    })),
    ...Object.entries(fingerprints).map(([name, fingerprint]) => ({
      name,
      bytes: fingerprint.bytes,
      accepts: (value: Buffer) =>
        createHash("sha256").update(value).digest("hex") === fingerprint.sha256,
    })),
  ];
  await forFiles(checks, async (check) => {
    const name = check.name;
    if (!actual.has(name) || !(await matches(join(root, name), check))) stale.push(name);
    actual.delete(name);
  });
  return [...stale, ...actual].toSorted();
}
export async function writeFiles(
  root: string,
  expected: Map<string, string>,
  boundary = dirname(root),
): Promise<void> {
  root = await ownedOutputRoot(root, boundary);
  for (const name of expected.keys())
    if (!/^(?:schema\/)?[A-Za-z][A-Za-z0-9_.]*\.(?:md|json)$/.test(name))
      throw new Error(`Invalid output path ${name}`);
  const actual = await paths(root);
  for (const [name, content] of expected) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  for (const name of actual) if (!expected.has(name)) await unlink(join(root, name));
}
const snapshotSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
  schemas: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*$/), z.record(z.string(), z.json())),
});
/** Reject deep documents before recursive schema parsing or validator compilation. */
export function parseSnapshot(raw: unknown): Snapshot {
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++count > 100_000 || item.depth > 64) throw new Error("Snapshot exceeds node/depth limits");
    if (typeof item.value === "object" && item.value !== null)
      for (const value of Object.values(item.value)) stack.push({ value, depth: item.depth + 1 });
  }
  const snapshot = snapshotSchema.parse(raw);
  if (Object.keys(snapshot.schemas).length > 1024) throw new Error("Snapshot exceeds 1024 schemas");
  const validator = jsonValidator(snapshot);
  for (const schema of Object.values(snapshot.schemas)) {
    if (typeof schema.$id !== "string") throw new Error("Snapshot schema must have a stable $id");
    validator.compile(schema);
  }
  const schemas = dictionary<JsonSchema>();
  for (const [name, schema] of Object.entries(snapshot.schemas)) schemas[name] = schema;
  return { ...snapshot, schemas };
}
export async function readSnapshot(path: string): Promise<Snapshot> {
  const handle = await open(path, "r");
  try {
    const limit = 8 * 1024 * 1024;
    if (!(await handle.stat()).isFile()) throw new Error("Snapshot must be a regular file");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Snapshot exceeds 8 MiB");
    return parseSnapshot(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
}
