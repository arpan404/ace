import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { z } from "zod";
const Manifest = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
async function locate(from: string, name: string): Promise<string> {
  let current = from;
  for (;;) {
    try {
      return await realpath(join(current, "node_modules", name));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Missing image runtime dependency: ${name}`);
    current = parent;
  }
}
/** Include native image decoder libraries and their license notices in standalone releases. */
export async function stageSharpRuntime(
  source: string,
  destination: string,
  target: string,
): Promise<string[]> {
  if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target))
    throw new Error(`Unsupported image runtime target: ${target}`);
  const manifests: string[] = [],
    staged = new Set<string>();
  async function stage(root: string): Promise<void> {
    const path = join(root, "package.json"),
      manifest = Manifest.parse(JSON.parse(await readFile(path, "utf8")));
    if (staged.has(manifest.name)) return;
    staged.add(manifest.name);
    const output = join(destination, "node_modules", manifest.name);
    await mkdir(output, { recursive: true });
    await cp(root, output, {
      recursive: true,
      dereference: false,
      filter: (entryPath) => basename(entryPath) !== "node_modules",
    });
    manifests.push(path);
    for (const name of Object.keys(manifest.dependencies ?? {}))
      await stage(await locate(root, name));
  }
  await stage(source);
  await stage(await locate(source, `@img/sharp-${target}`));
  if (!target.startsWith("win32-"))
    await stage(await locate(source, `@img/sharp-libvips-${target}`));
  return manifests;
}
