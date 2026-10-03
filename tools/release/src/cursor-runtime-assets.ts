import { cp, mkdir, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, parse } from "node:path";
import { z } from "zod";

const Name = z
  .string()
  .max(256)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const Manifest = z.object({
  name: Name,
  version: z.string().min(1).max(256),
  dependencies: z.record(Name, z.string()).default({}),
  peerDependencies: z.record(Name, z.string()).default({}),
  optionalDependencies: z.record(Name, z.string()).default({}),
});

async function manifestAt(root: string) {
  const file = await open(join(root, "package.json"), "r");
  try {
    const buffer = Buffer.alloc(65537);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > 65536) throw new Error("Cursor runtime manifest exceeds budget");
    return Manifest.parse(JSON.parse(buffer.toString("utf8", 0, bytes)));
  } finally {
    await file.close();
  }
}

async function packageRoot(from: string, name: string): Promise<string> {
  const resolve = createRequire(join(from, "package.json")).resolve;
  let entry: string;
  try {
    entry = resolve(`${name}/package.json`);
  } catch {
    entry = resolve(name);
  }
  let root = dirname(await realpath(entry));
  for (let depth = 0; depth < 16 && root !== parse(root).root; depth++) {
    try {
      if ((await manifestAt(root)).name === name) return root;
    } catch {
      // Published entry points can live below nested build package manifests.
    }
    root = dirname(root);
  }
  throw new Error(`Cursor runtime package root missing: ${name}`);
}

/** Stage the installed, pinned SDK unchanged, including its Node runtime closure and target helpers. */
export async function stageCursorRuntime(source: string, destination: string, target: string) {
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target))
    throw new Error(`Unsupported Cursor runtime target: ${target}`);
  const sdkRoot = await realpath(source);
  const sdk = await manifestAt(sdkRoot);
  if (sdk.name !== "@cursor/sdk" || sdk.version !== "1.0.35")
    throw new Error("Release requires @cursor/sdk 1.0.35");
  const helper = `@cursor/sdk-${target}`;
  if (sdk.optionalDependencies[helper] !== sdk.version)
    throw new Error(`Missing Cursor runtime helper for ${target}`);
  const queue = [{ name: sdk.name, source: sdkRoot }];
  const staged = new Map<string, string>();
  const manifests: string[] = [];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 64) throw new Error("Cursor runtime dependency closure exceeds budget");
    const entry = queue[index];
    if (!entry) throw new Error("Cursor runtime dependency is missing");
    const manifest = await manifestAt(entry.source);
    if (manifest.name !== entry.name) throw new Error("Cursor runtime dependency identity changed");
    const existing = staged.get(entry.name);
    if (existing) {
      if (existing !== manifest.version)
        throw new Error(`Conflicting Cursor runtime dependency versions: ${entry.name}`);
      continue;
    }
    if (entry.name === helper && manifest.version !== sdk.version)
      throw new Error("Cursor runtime helper version changed");
    staged.set(entry.name, manifest.version);
    const targetRoot = join(destination, "node_modules", entry.name);
    await mkdir(targetRoot, { recursive: true });
    await cp(entry.source, targetRoot, {
      recursive: true,
      dereference: false,
      filter: (path) => basename(path) !== "node_modules",
    });
    manifests.push(join(entry.source, "package.json"));
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies),
      ...(entry.name === sdk.name ? [helper] : []),
    ]);
    if (entry.name !== sdk.name && Object.keys(manifest.optionalDependencies).length)
      throw new Error(`Unreviewed Cursor runtime optional dependencies: ${entry.name}`);
    for (const name of dependencies) {
      if (queue.length >= 64) throw new Error("Cursor runtime dependency closure exceeds budget");
      queue.push({ name, source: await packageRoot(entry.source, name) });
    }
  }
  return manifests;
}
