import { z } from "zod";
import { CatalogEntry, type ProviderKind } from "@ace/protocol";
const text = z.string().max(4096);
const row = z
  .object({
    id: text.optional(),
    name: text.optional(),
    description: text.optional(),
    path: text.optional(),
    scope: text.optional(),
    hidden: z.boolean().optional(),
    enabled: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
    isAccessible: z.boolean().optional(),
    pluginId: text.nullish(),
    logoUrl: text.nullish(),
    interface: z
      .object({
        displayName: text.nullish(),
        shortDescription: text.nullish(),
        iconSmall: text.nullish(),
      })
      .optional(),
  })
  .passthrough();
const page = z.object({ data: z.array(z.unknown()).max(512) }).passthrough();
const skills = z.object({
  data: z.array(z.object({ cwd: text, skills: z.array(z.unknown()).max(512) })).max(32),
});
export const HarnessCatalog = z.object({ method: text, result: z.unknown(), cwd: text.optional() });
/** Pick display and invocation metadata only. Configurations and credentials never enter this catalog. */
export function harnessCatalog(
  provider: ProviderKind,
  method: string,
  result: unknown,
  cwd?: string,
): CatalogEntry[] | undefined {
  const parsed = page.safeParse(result);
  let values: unknown[] | undefined = parsed.success ? parsed.data.data : undefined;
  const skillPage = method === "skills/list" ? skills.safeParse(result) : undefined;
  if (skillPage?.success)
    values = skillPage.data.data
      .filter((p) => !cwd || p.cwd === cwd)
      .flatMap((p) => p.skills)
      .slice(0, 512);
  if (!values) return undefined;
  const output: CatalogEntry[] = [];
  for (const value of values) {
    const item = row.safeParse(value);
    if (!item.success) continue;
    const v = item.data;
    if (v.hidden) continue;
    const disabled = v.enabled === false || v.isEnabled === false || v.isAccessible === false;
    const name = v.name ?? v.id;
    if (!name) continue;
    const source = {
      provider,
      scope: v.pluginId
        ? ("plugin" as const)
        : v.scope === "repo" || v.scope === "project" || (cwd && v.path?.startsWith(`${cwd}/`))
          ? ("project" as const)
          : ("global" as const),
      ...(v.path ? { path: v.path } : {}),
      ...(v.pluginId ? { plugin: v.pluginId } : {}),
    };
    let entry: CatalogEntry | undefined;
    if (method === "skills/list" || method === "skill.list") {
      const path = provider === "opencode" ? (v.id ?? v.path) : (v.path ?? v.id);
      if (!path) continue;
      entry = {
        id: `${provider}:skill:${path}`,
        kind: "skill",
        name: v.interface?.displayName ?? name,
        description: (v.interface?.shortDescription ?? v.description ?? "").slice(0, 2048),
        source,
        invocation: { type: "skill", name, path },
      };
    } else if (method === "app/list") {
      if (!v.id) continue;
      entry = {
        id: `${provider}:app:${v.id}`,
        kind: "plugin",
        name,
        description: (v.description ?? "").slice(0, 2048),
        source: { ...source, scope: "plugin", plugin: name },
        invocation: { type: "mention", name, path: `app://${v.id}` },
        ...(v.logoUrl ? { icon: v.logoUrl } : {}),
      };
    } else if (method === "agent.list")
      entry = {
        id: `${provider}:agent:${v.id ?? name}`,
        kind: "agent",
        name,
        description: (v.description ?? "").slice(0, 2048),
        source,
        invocation: { type: "agent", name },
      };
    else if (method === "plugin.list")
      entry = {
        id: `${provider}:plugin:${v.id ?? name}`,
        kind: "plugin",
        name,
        description: (v.description ?? "").slice(0, 2048),
        source: { ...source, scope: "plugin", plugin: name },
        invocation: {
          type: "unavailable",
          reason: "This plugin exposes hooks; invoke its advertised skills, commands or tools",
        },
      };
    else if (method === "mcpServerStatus/list" || method === "mcp.list") {
      output.push({
        id: `${provider}:mcp-server:${name}`,
        kind: "plugin",
        name: `MCP: ${name}`,
        description: `MCP server${typeof v.status === "string" ? ` (${v.status})` : ""}`,
        source,
        invocation: { type: "unavailable", reason: "Select an advertised tool from this server" },
      });
      const tools = z
        .record(z.string(), z.object({ name: text, description: text.optional() }).passthrough())
        .safeParse(v.tools);
      if (!tools.success) continue;
      for (const tool of Object.values(tools.data)) {
        if (output.length >= 512) break;
        output.push({
          id: `${provider}:mcp:${name}:${tool.name}`,
          kind: "mcp-tool",
          name: tool.name,
          description: (tool.description ?? "").slice(0, 2048),
          source,
          invocation: { type: "tool", name: tool.name, server: name },
        });
      }
    }
    if (entry) {
      if (disabled) entry.name = name;
      if (disabled)
        entry.invocation = {
          type: "unavailable",
          reason: "Disabled or inaccessible in the provider",
        };
      if (v.interface?.iconSmall) entry.icon = v.interface.iconSmall;
      const checked = CatalogEntry.safeParse(entry);
      if (checked.success) output.push(checked.data);
    }
    if (output.length >= 512) break;
  }
  return output;
}
