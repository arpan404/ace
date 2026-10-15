import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PluginInstall } from "@ace/protocol/plugins";
import { PluginManifest, parseJson } from "./manifest.ts";
import type { PluginSnapshot } from "./types.ts";
import { projectPlugins } from "./project.ts";
import { materializeProjection, removeProjection } from "./materialize.ts";

const shippedRoot = fileURLToPath(new URL("../builtin-skills", import.meta.url));

/**
 * The shipped skills as a plain skills directory (`<name>/SKILL.md` per skill), read in place.
 * OpenCode (`skills` config), Pi (`--skill`) and Cursor (copied into its private home) discover
 * skills from such a directory; Claude Code and Codex get a projected plugin instead.
 */
export function builtinSkillsDirectory(root = shippedRoot): string {
  return join(root, "skills");
}

/** Shipped, data-only skills. Provider config is projected into an exclusive session root. */
export async function builtinSkills(root = shippedRoot): Promise<PluginSnapshot[]> {
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

/**
 * The shipped skills as guides for providers without native skills: name, the frontmatter's
 * one-line description and the body. Same files as the native projection, so one source.
 * Frontmatter is parsed as the YAML that provider skill loaders read, so a broken one fails here.
 */
export async function builtinGuides(
  root?: string,
): Promise<{ name: string; description: string; body: string }[]> {
  const [bundle] = await builtinSkills(root);
  if (!bundle) return [];
  return bundle.manifest.skills.map((skill) => {
    const text = bundle.text[`${skill.path}/SKILL.md`] ?? "";
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const meta = SkillFrontmatter.safeParse(parseYaml(match?.[1] ?? ""));
    if (!match || !meta.success || meta.data.name !== skill.name)
      throw new Error(`Built-in skill ${skill.name} has invalid frontmatter`);
    return {
      name: skill.name,
      description: meta.data.description,
      body: text.slice(match[0].length).trim(),
    };
  });
}
const SkillFrontmatter = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
});
