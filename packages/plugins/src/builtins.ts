import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PluginInstall } from "@ace/protocol/plugins";
import { PluginManifest, parseJson } from "./manifest.ts";
import type { PluginSnapshot } from "./types.ts";
import { projectPlugins } from "./project.ts";
import { materializeProjection, removeProjection } from "./materialize.ts";

// Resolved on use, not on import: a bundle that imports this module without reading skills
// (a browser test importing the daemon) has no file URL for it.
const shippedRoot = () => fileURLToPath(new URL("../builtin-skills", import.meta.url));

/**
 * The shipped skills as a plain skills directory (`<name>/SKILL.md` per skill), read in place.
 * OpenCode (`skills` config), Pi (`--skill`) and Cursor (copied into its private home) discover
 * skills from such a directory; Claude Code and Codex get a projected plugin instead.
 */
export function builtinSkillsDirectory(root = shippedRoot()): string {
  return join(root, "skills");
}

/** Shipped, data-only skills. Provider config is projected into an exclusive session root. */
export async function builtinSkills(root = shippedRoot()): Promise<PluginSnapshot[]> {
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
    // SKILL.md and the reference files beside it (`references/*.md`), so every projection
    // carries the same folder the skill points into.
    for (const path of [`${skill.path}/SKILL.md`, ...(await skillReferences(root, skill.path))]) {
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
/** A skill's reference files: Markdown under its `references/` folder, sorted, as bundle paths. */
async function skillReferences(root: string, skill: string): Promise<string[]> {
  const entries = await readdir(join(root, skill, "references"), { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${skill}/references/${entry.name}`)
    .toSorted();
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
 * one-line description, the body and its reference files. Same files as the native projection, so one source.
 * Frontmatter is parsed as the YAML that provider skill loaders read, so a broken one fails here.
 */
export async function builtinGuides(
  root = shippedRoot(),
): Promise<{ name: string; description: string; body: string; files: Record<string, string> }[]> {
  const [bundle] = await builtinSkills(root);
  const text = bundle?.text ?? {};
  const sources = (bundle?.manifest.skills ?? []).map((skill) => ({
    name: skill.name,
    text: text[`${skill.path}/SKILL.md`] ?? "",
    // Reference files by their path inside the skill (`references/suit-json.md`).
    files: Object.fromEntries(
      Object.entries(text).flatMap(([path, content]) =>
        path.startsWith(`${skill.path}/references/`)
          ? [[path.slice(skill.path.length + 1), content]]
          : [],
      ),
    ),
  }));
  return sources.map(({ name, text, files }) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const meta = SkillFrontmatter.safeParse(parseYaml(match?.[1] ?? ""));
    if (!match || !meta.success || meta.data.name !== name)
      throw new Error(`Built-in skill ${name} has invalid frontmatter`);
    const body = text.slice(match[0].length).trim();
    return { name, description: meta.data.description, body, files };
  });
}
const SkillFrontmatter = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
});
