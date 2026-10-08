import { dataWeight } from "./limits.ts";
import { z } from "zod";
import { PaletteName } from "@ace/protocol";
import type { ParsedSource, Target, Definition } from "./types.ts";
const entry = z
  .object({
    name: PaletteName,
    description: z.string().max(2048).default(""),
    input: z
      .object({ hint: z.string().max(1024) })
      .passthrough()
      .nullable()
      .optional(),
    argumentHint: z.string().max(1024).optional(),
  })
  .passthrough();
const claude = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    slash_commands: z.array(z.unknown()).max(512),
    skills: z.array(z.string()).max(512).optional(),
    terminal_slash_commands: z.array(z.string()).max(512).default([]),
  })
  .passthrough();
const acp = z
  .object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(z.unknown()).max(512),
  })
  .passthrough();
/** Adapters feed the Claude init or ACP update body. Unknown fields stay in raw metadata. */
export function parseRuntime(input: unknown, target: Target): ParsedSource {
  const source = `runtime:${target.session}`;
  if (dataWeight(input) === undefined)
    return {
      commands: [],
      diagnostics: [{ source, message: "Runtime command metadata limit exceeded" }],
    };
  const init = target.provider === "claude" ? claude.safeParse(input) : undefined;
  const update = acp.safeParse(input);
  const items = init?.success
    ? init.data.slash_commands
    : update.success
      ? update.data.availableCommands
      : undefined;
  if (!items)
    return {
      commands: [],
      diagnostics: [{ source, message: "Unrecognized runtime command list" }],
    };
  const result: ParsedSource = { commands: [], diagnostics: [] };
  for (const item of items) {
    const parsed = entry.safeParse(typeof item === "string" ? { name: item } : item);
    if (!parsed.success) {
      result.diagnostics.push({ source, message: "Invalid runtime command entry" });
      continue;
    }
    const v = parsed.data;
    const hint = v.argumentHint ?? v.input?.hint;
    const d: Definition = {
      id: `${source}#${v.name}`,
      name: v.name,
      nativeName: v.name,
      description: v.description,
      namespace: "provider",
      provider: target.provider,
      instance: target.instance,
      session: target.session,
      arguments: {},
      scope: "runtime",
      body: "",
      format: "runtime",
      raw: v,
      priority: 30,
      ...(hint === undefined ? {} : { argumentHint: hint }),
      ...(init?.success && init.data.terminal_slash_commands.includes(v.name)
        ? { unavailable: true }
        : {}),
    };
    if (init?.success && init.data.skills?.includes(v.name))
      d.extension = {
        id: d.id,
        kind: "skill",
        name: v.name,
        description: v.description,
        source: { provider: target.provider, scope: "global" },
        invocation: { type: "slash", name: v.name },
      };
    result.commands.push(d);
  }
  if (init?.success) {
    const servers = z
      .array(z.object({ name: z.string().min(1).max(128) }))
      .max(128)
      .safeParse(init.data.mcp_servers);
    if (servers.success)
      for (const server of servers.data) {
        if (result.commands.length >= 512) break;
        const id = `${source}#mcp-server:${server.name}`;
        result.commands.push({
          id,
          name: server.name,
          nativeName: server.name,
          namespace: "provider",
          provider: target.provider,
          instance: target.instance,
          session: target.session,
          description: "MCP server",
          arguments: {},
          scope: "runtime",
          body: "",
          format: "runtime",
          raw: {},
          priority: 30,
          extension: {
            id,
            kind: "plugin",
            name: `MCP: ${server.name}`,
            description: "MCP server",
            source: { provider: target.provider, scope: "global" },
            invocation: {
              type: "unavailable",
              reason: "Select an advertised tool from this server",
            },
          },
        });
      }
    const plugins = z
      .array(
        z.object({ name: z.string().min(1).max(128), path: z.string().max(4096) }).passthrough(),
      )
      .max(128)
      .safeParse(init.data.plugins);
    if (plugins.success)
      for (const plugin of plugins.data) {
        if (result.commands.length >= 512) break;
        result.commands.push({
          id: `${source}#plugin:${plugin.name}`,
          name: plugin.name,
          nativeName: plugin.name,
          namespace: "provider",
          provider: target.provider,
          instance: target.instance,
          session: target.session,
          description: "Enabled provider plugin",
          arguments: {},
          scope: "runtime",
          body: "",
          format: "runtime",
          raw: {},
          priority: 30,
          extension: {
            id: `${source}#plugin:${plugin.name}`,
            name: plugin.name,
            kind: "plugin",
            description: "Enabled provider plugin",
            source: {
              provider: target.provider,
              scope: "plugin",
              plugin: plugin.name,
              path: plugin.path,
            },
            invocation: { type: "plugin", name: plugin.name },
          },
        });
      }
    const tools = z.array(z.string().max(256)).max(512).safeParse(init.data.tools);
    if (tools.success)
      for (const tool of tools.data) {
        const match = /^mcp__(.+?)__(.+)$/.exec(tool);
        if (!match?.[1] || !match[2] || result.commands.length >= 512) continue;
        result.commands.push({
          id: `${source}#tool:${tool}`,
          name: tool,
          nativeName: tool,
          namespace: "provider",
          provider: target.provider,
          instance: target.instance,
          session: target.session,
          description: `Tool from ${match[1]}`,
          arguments: {},
          scope: "runtime",
          body: "",
          format: "runtime",
          raw: {},
          priority: 30,
          extension: {
            id: `${source}#tool:${tool}`,
            name: match[2],
            kind: "mcp-tool",
            description: `Tool from ${match[1]}`,
            source: { provider: target.provider, scope: "global" },
            invocation: { type: "tool", name: tool, server: match[1] },
          },
        });
      }
  }
  return result;
}
