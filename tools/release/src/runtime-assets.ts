import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { z } from "zod";

/** These packages locate runtime files relative to their installed package roots. */
export const runtimePackages = [
  { name: "koffi", workspace: "packages/files" },
  { name: "playwright-core", workspace: "packages/browser" },
  { name: "@anthropic-ai/claude-agent-sdk", workspace: "packages/adapter-claude" },
];
const Manifest = z.object({
  name: z.string(),
  version: z.string(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

export async function stageRuntimePackages(
  repo: string,
  root: string,
  target = `${process.platform}-${process.arch}`,
): Promise<string[]> {
  const manifests: string[] = [];
  for (const pkg of runtimePackages) {
    const source = await realpath(join(repo, pkg.workspace, "node_modules", pkg.name));
    const manifest = join(source, "package.json");
    const parsed = Manifest.parse(JSON.parse(await readFile(manifest, "utf8")));
    if (parsed.name !== pkg.name || Object.keys(parsed.dependencies ?? {}).length)
      throw new Error(`Runtime package dependency closure changed: ${pkg.name}`);
    const destination = join(root, "node_modules", pkg.name);
    await mkdir(destination, { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      filter: (path) => basename(path) !== "node_modules",
    });
    manifests.push(manifest);
    if (pkg.name === "koffi") {
      const name = `@koromix/koffi-${target}`;
      if (parsed.optionalDependencies?.[name] !== parsed.version)
        throw new Error(`Missing Koffi native dependency for ${target}`);
      const native = await realpath(join(dirname(source), name));
      const nativeManifest = join(native, "package.json");
      const info = Manifest.parse(JSON.parse(await readFile(nativeManifest, "utf8")));
      if (
        info.name !== name ||
        info.version !== parsed.version ||
        Object.keys(info.dependencies ?? {}).length ||
        Object.keys(info.optionalDependencies ?? {}).length
      )
        throw new Error(`Runtime package dependency closure changed: ${name}`);
      await mkdir(join(root, "node_modules", name), { recursive: true });
      await cp(native, join(root, "node_modules", name), { recursive: true, dereference: false });
      manifests.push(nativeManifest);
    }
  }
  return manifests;
}
