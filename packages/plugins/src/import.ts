import { z } from "zod";
import { PluginName } from "@ace/protocol/plugins";
import { PluginManifest, limits, normalizePath, parseJson } from "./manifest.ts";
import { mcpReader, hookReader } from "./import-components.ts";
import type { ImportedPlugin } from "./types.ts";

export const agentPluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const agentMcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const pathField = z.union([z.string(), z.array(z.string()).max(256)]);
const nativeManifest = z
  .object({
    name: PluginName,
    version: z.string().max(128).optional(),
    description: z.string().max(8192).optional(),
    skills: pathField.optional(),
    commands: z
      .union([
        pathField,
        z.record(
          PluginName,
          z.object({
            source: z.string().optional(),
            content: z.string().max(limits.json).optional(),
            description: z.string().optional(),
          }),
        ),
      ])
      .optional(),
    agents: pathField.optional(),
    rules: pathField.optional(),
    hooks: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
  })
  .passthrough();
const portableManifest = z.object({
  $schema: z.literal(agentPluginSchema),
  name: PluginName,
  version: z.string().max(128).optional(),
  description: z.string().max(8192).optional(),
  author: z
    .strictObject({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.unknown().optional(),
});
const object = z.record(z.string(), z.unknown());
function directoryPath(input: string): string {
  return normalizePath(input.endsWith("/") ? input.slice(0, -1) : input);
}
function paths(input: string | string[] | undefined, fallback: string): string[] {
  return (input === undefined ? [fallback] : typeof input === "string" ? [input] : input).map(
    directoryPath,
  );
}

/** Import only data. Unknown native capabilities are reported and never activated. */
export function importPlugin(files: Record<string, string>): ImportedPlugin {
  if (Object.keys(files).length > limits.files) throw new Error("Too many files");
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    normalizePath(path);
    const bytes = Buffer.byteLength(content);
    if (bytes > limits.file || (total += bytes) > limits.total)
      throw new Error("Package exceeds byte limit");
  }
  const unsupported: string[] = [];
  const inlineFiles: Record<string, string> = Object.create(null);
  const ace = files["ace-plugin.json"];
  if (ace !== undefined)
    return {
      manifest: PluginManifest.parse(parseJson(ace)),
      metadata: {},
      unsupported,
      inlineFiles,
    };
  const portable = files["plugin.json"];
  const nativePath = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ].find((path) => files[path] !== undefined);
  const content = portable ?? (nativePath ? files[nativePath] : undefined);
  if (!content) throw new Error("Plugin manifest missing");
  const raw = object.parse(parseJson(content));
  const isPortable = portable !== undefined;
  const metadata = isPortable ? portableManifest.parse(raw) : nativeManifest.parse(raw);
  const manifest = nativeManifest.parse(
    isPortable
      ? { name: metadata.name, version: metadata.version, description: metadata.description }
      : raw,
  );
  if (isPortable) {
    for (const key of Object.keys(raw))
      if (!(key in portableManifest.shape)) unsupported.push(`Ignored Agent Plugins field: ${key}`);
    if (raw.extensions !== undefined) {
      const extensions = object.safeParse(raw.extensions);
      if (extensions.success)
        for (const key of Object.keys(extensions.data))
          unsupported.push(`Unsupported extension: ${key}`);
      else unsupported.push("Ignored invalid extensions object");
    }
  } else {
    const supported = new Set([
      "name",
      "version",
      "description",
      "skills",
      "commands",
      "agents",
      "rules",
      "hooks",
      "mcpServers",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "$schema",
      "displayName",
    ]);
    for (const key of Object.keys(raw))
      if (!supported.has(key)) unsupported.push(`Unsupported native field: ${key}`);
  }
  const isCursor = nativePath === ".cursor-plugin/plugin.json" && !isPortable;
  const skills = [
    ...new Set([...(isCursor ? [] : ["skills"]), ...paths(manifest.skills, "skills")]),
  ].flatMap((root) =>
    Object.keys(files)
      .filter(
        (path) =>
          path.startsWith(`${root}/`) &&
          path.endsWith("/SKILL.md") &&
          path.slice(root.length + 1).split("/").length === 2,
      )
      .map((path) => ({ name: PluginName.parse(path.split("/").at(-2)), path: path.slice(0, -9) })),
  );
  // A custom skill path may name the skill directory itself.
  for (const root of paths(manifest.skills, "skills"))
    if (files[`${root}/SKILL.md`] !== undefined && !skills.some((skill) => skill.path === root))
      skills.push({ name: PluginName.parse(root.split("/").at(-1)), path: root });
  function documents(input: string | string[] | undefined, fallback: string) {
    return paths(input, fallback).flatMap((root) =>
      Object.keys(files)
        .filter(
          (path) =>
            (path === root || path.startsWith(`${root}/`)) && /\.(md|mdc|markdown|txt)$/.test(path),
        )
        .map((path) => ({
          name: PluginName.parse(
            path
              .split("/")
              .at(-1)
              ?.replace(/\.[^.]+$/, ""),
          ),
          path,
        })),
    );
  }
  const commands =
    typeof manifest.commands === "object" && !Array.isArray(manifest.commands)
      ? Object.entries(manifest.commands).map(([name, command]) => {
          if ((command.source === undefined) === (command.content === undefined))
            throw new Error("Command needs exactly one source or content");
          const path =
            command.source === undefined
              ? `.ace-inline/commands/${name}.md`
              : normalizePath(command.source);
          if (command.content !== undefined) inlineFiles[path] = command.content;
          return {
            name,
            path,
            description: command.description ?? name,
          };
        })
      : isPortable
        ? []
        : documents(manifest.commands, "commands");
  const { mcpServers, readMcp } = mcpReader(files, isPortable);
  const mcpFile = isPortable
    ? "mcp.json"
    : nativePath === ".cursor-plugin/plugin.json"
      ? "mcp.json"
      : ".mcp.json";
  if (files[mcpFile] !== undefined && !(isCursor && manifest.mcpServers !== undefined)) {
    const value = parseJson(files[mcpFile]);
    if (isPortable)
      z.strictObject({ $schema: z.literal(agentMcpSchema), mcpServers: object }).parse(value);
    readMcp(value);
  }
  if (!isPortable && manifest.mcpServers !== undefined) readMcp(manifest.mcpServers);
  const { hooks, readHooks } = hookReader(files, unsupported);
  if (!isPortable) {
    if (files["hooks/hooks.json"] !== undefined && !(isCursor && manifest.hooks !== undefined))
      readHooks(parseJson(files["hooks/hooks.json"]));
    if (manifest.hooks !== undefined) readHooks(manifest.hooks);
  }
  return {
    manifest: PluginManifest.parse({
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version ?? "unversioned",
      ...(manifest.description ? { description: manifest.description } : {}),
      skills,
      commands,
      agents: isPortable ? [] : documents(manifest.agents, "agents"),
      rules: isPortable ? [] : documents(manifest.rules, "rules"),
      mcpServers,
      hooks,
    }),
    unsupported,
    metadata: raw,
    inlineFiles,
  };
}
