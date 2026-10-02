import { z } from "zod";
import { PluginName, PluginHash } from "@ace/protocol/plugins";

export const limits = {
  json: 256 * 1024,
  file: 4 * 1024 * 1024,
  total: 32 * 1024 * 1024,
  files: 2048,
  installs: 256,
  pending: 32,
};
export const PluginPath = z
  .string()
  .min(1)
  .max(512)
  .refine((input) => {
    const value = input.startsWith("./") ? input.slice(2) : input;
    return (
      !value.includes("\\") &&
      !/[<>:"|?*]/.test(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
            ![".git", "__proto__", "constructor", "prototype"].includes(part) &&
            !/[. ]$/.test(part),
        )
    );
  }, "Must be a contained relative path");
export function normalizePath(input: string): string {
  const path = PluginPath.parse(input);
  return path.startsWith("./") ? path.slice(2) : path;
}
const text = z.string().max(8192);
const env = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(128),
    text,
  )
  .default({});
export const McpServer = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: text.min(1),
    args: z.array(text).max(128).default([]),
    env,
    cwd: z
      .string()
      .max(512)
      .refine((value) => {
        const placeholder = /^\$\{(?:(?:ACE|CLAUDE|CURSOR)_)?PLUGIN_ROOT\}(?:\/(.*))?$/.exec(value);
        const relative = placeholder ? (placeholder[1] ?? "") : value;
        return (
          !relative.includes("${") &&
          ((placeholder && relative === "") ||
            relative === "." ||
            relative === "./" ||
            PluginPath.safeParse(relative).success)
        );
      }, "MCP cwd must remain within the plugin root")
      .optional(),
  }),
  z.strictObject({
    type: z.enum(["http", "sse"]),
    url: z
      .url()
      .max(8192)
      .refine((url) => /^https?:\/\//.test(url)),
    headers: z.record(z.string().max(128), text).default({}),
  }),
]);
export type McpServer = z.infer<typeof McpServer>;
export const Hook = z.strictObject({
  event: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  command: text.min(1),
  matcher: text.optional(),
});
const component = z.strictObject({
  name: PluginName,
  path: PluginPath,
  description: z.string().max(8192).optional(),
});
const components = z
  .array(component)
  .max(256)
  .default([])
  .refine(
    (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
    "Duplicate component name",
  );
export const PluginManifest = z.strictObject({
  schemaVersion: z.literal(1),
  name: PluginName,
  version: z.string().min(1).max(128),
  description: text.optional(),
  skills: components,
  commands: components,
  agents: components,
  rules: components,
  mcpServers: z
    .record(PluginName, McpServer)
    .default({})
    .refine((servers) => Object.keys(servers).length <= 256),
  hooks: z.array(Hook).max(256).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export const Marketplace = z
  .object({
    name: PluginName,
    plugins: z
      .array(
        z.object({
          name: PluginName,
          source: z.union([PluginPath, z.literal("."), z.literal("./")]),
          hash: PluginHash.optional(),
        }),
      )
      .max(256),
  })
  .refine(
    (catalog) =>
      new Set(catalog.plugins.map((plugin) => plugin.name)).size === catalog.plugins.length,
    "Duplicate catalog entry",
  );
export function parseJson(input: string): unknown {
  if (Buffer.byteLength(input) > limits.json) throw new Error("JSON exceeds byte limit");
  return JSON.parse(input);
}
