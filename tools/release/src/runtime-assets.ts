import { stageSharpRuntime } from "./sharp-runtime-assets.ts";
import { stageCursorRuntime } from "./cursor-runtime-assets.ts";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { copyRuntimePackage } from "./copy-runtime-package.ts";
import { z } from "zod";

/** These packages locate runtime files relative to their installed package roots. */
export const runtimePackages = [
  { name: "sharp", workspace: "packages/devices" },
  { name: "@anthropic-ai/claude-agent-sdk", workspace: "packages/adapter-claude" },
  { name: "@cursor/sdk", workspace: "packages/adapter-cursor" },
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
    if (pkg.name === "sharp") {
      manifests.push(...(await stageSharpRuntime(source, root, target)));
      continue;
    }
    if (pkg.name === "@cursor/sdk") {
      manifests.push(...(await stageCursorRuntime(source, root, target)));
      continue;
    }
    const manifest = join(source, "package.json");
    const parsed = Manifest.parse(JSON.parse(await readFile(manifest, "utf8")));
    if (parsed.name !== pkg.name || Object.keys(parsed.dependencies ?? {}).length)
      throw new Error(`Runtime package dependency closure changed: ${pkg.name}`);
    const destination = join(root, "node_modules", pkg.name);
    await copyRuntimePackage(source, destination);
    manifests.push(manifest);
  }
  return manifests;
}
