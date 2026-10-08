import { join } from "node:path";
import { limits, normalizePath } from "./manifest.ts";
import type { PluginSnapshot, PluginProjection, ProjectedFile } from "./types.ts";

export function expandRoot(value: string, root: string): string {
  return value.replace(/\$\{(?:ACE|CLAUDE|CURSOR)_PLUGIN_ROOT\}|\$\{PLUGIN_ROOT\}/g, () => root);
}
export { componentBody as body } from "./component-title.ts";
export function textFile(plugin: PluginSnapshot, path: string): string {
  const text = plugin.text[normalizePath(path)];
  if (text === undefined) throw new Error(`Component text missing: ${path}`);
  return text;
}
export function outputFile(path: string, content: string): ProjectedFile {
  return { path, content, executable: false };
}
export function payloadFiles(plugin: PluginSnapshot, base: string): ProjectedFile[] {
  return plugin.files.map((file) => ({
    path: `${base}/payload/${file.path}`,
    executable: file.executable,
    source: { path: join(plugin.root, file.path), hash: file.hash },
  }));
}
export function skillFiles(plugin: PluginSnapshot, base: string, root: string): ProjectedFile[] {
  const result: ProjectedFile[] = [];
  const roots = new Map<string, typeof plugin.manifest.skills>();
  for (const skill of plugin.manifest.skills) {
    const path = normalizePath(skill.path);
    const entries = roots.get(path);
    if (entries) entries.push(skill);
    else roots.set(path, [skill]);
  }
  // Inspect each bounded-depth ancestor once instead of scanning all files per skill.
  for (const file of plugin.files) {
    let separator = file.path.lastIndexOf("/");
    while (separator > 0) {
      const prefix = file.path.slice(0, separator);
      for (const skill of roots.get(prefix) ?? []) {
        if (result.length >= limits.files * 2) throw new Error("Projected skill file limit");
        const path = `${base}/skills/${skill.name}/${file.path.slice(separator + 1)}`;
        if (file.path === `${prefix}/SKILL.md`)
          result.push(outputFile(path, expandRoot(textFile(plugin, file.path), root)));
        else
          result.push({
            path,
            executable: file.executable,
            source: { path: join(plugin.root, file.path), hash: file.hash },
          });
      }
      separator = file.path.lastIndexOf("/", separator - 1);
    }
  }
  return result;
}
export function nativeHooks(
  plugin: PluginSnapshot,
  root: string,
  supported: ReadonlySet<string>,
  projection: PluginProjection,
): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = Object.create(null);
  for (const hook of plugin.manifest.hooks) {
    if (!supported.has(hook.event)) {
      projection.unsupported.push(`${plugin.manifest.name}: unsupported hook ${hook.event}`);
      continue;
    }
    (hooks[hook.event] ??= []).push({
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      hooks: [{ type: "command", command: expandRoot(hook.command, root) }],
    });
  }
  return hooks;
}
export const claudeEvents = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "TeammateIdle",
  "TaskCompleted",
]);
export const codexEvents = new Set([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
]);
export function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`)
      .join(",")}}`;
  throw new Error("Cannot encode TOML value");
}
export function override(projection: PluginProjection, key: string, value: unknown): void {
  projection.args.push("-c", `${key}=${toml(value)}`);
}

export { projectionName } from "./projection-name.ts";
