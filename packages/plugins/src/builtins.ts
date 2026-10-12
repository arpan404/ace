import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PluginInstall } from "@ace/protocol/plugins";
import { PluginManifest, parseJson } from "./manifest.ts";
import type { PluginSnapshot } from "./types.ts";
import { projectPlugins } from "./project.ts";
import { materializeProjection, removeProjection } from "./materialize.ts";

/** Shipped, data-only skills. Provider config is projected into an exclusive session root. */
export async function builtinSkills(
  root = fileURLToPath(new URL("../builtin-skills", import.meta.url)),
): Promise<PluginSnapshot[]> {
  const manifest = PluginManifest.parse(
    parseJson(await readFile(join(root, "ace-plugin.json"), "utf8")),
  );
  if (
    manifest.commands.length ||
    manifest.agents.length ||
    manifest.rules.length ||
    manifest.hooks.length ||
    Object.keys(manifest.mcpServers).length
  )
    throw new Error("Built-in bundle must contain only skills");
  const files: PluginSnapshot["files"] = [];
  const text: Record<string, string> = {};
  for (const skill of manifest.skills) {
    const path = `${skill.path}/SKILL.md`;
    const content = await readFile(join(root, path), "utf8");
    if (Buffer.byteLength(content) > 65536) throw new Error("Built-in skill exceeds limit");
    text[path] = content;
    files.push({
      path,
      bytes: Buffer.byteLength(content),
      executable: false,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
  const hash = createHash("sha256").update(JSON.stringify({ manifest, files })).digest("hex");
  return [
    {
      manifest,
      root,
      files,
      text,
      unsupported: [],
      install: PluginInstall.parse({
        name: manifest.name,
        version: manifest.version,
        commit: "0".repeat(40),
        hash,
        acceptedAt: 0,
      }),
    },
  ];
}
export async function prepareBuiltinSkills(provider: "claude" | "codex", root: string) {
  const projection = projectPlugins(provider, await builtinSkills(), { root });
  await materializeProjection(projection, { root });
  const directories: string[] = [];
  for (let at = 0; at < projection.args.length; at++) {
    const path = projection.args[at + 1];
    if (projection.args[at] === "--plugin-dir" && path) directories.push(path);
  }
  return { args: projection.args, directories, close: () => removeProjection(root) };
}
