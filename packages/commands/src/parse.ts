import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { PaletteName, PromptArgument, ProviderKind } from "@ace/protocol";
import type { Definition, ParsedSource, ParseContext } from "./types.ts";

const providerMeta = z
  .object({
    name: PaletteName.optional(),
    description: z.string().max(2048).default(""),
    "argument-hint": z.string().max(1024).optional(),
    "user-invocable": z.boolean().optional(),
  })
  .passthrough();
const libraryMeta = providerMeta.extend({
  provider: z.union([ProviderKind, z.literal("any")]).default("any"),
  arguments: z
    .record(PaletteName, PromptArgument)
    .default({})
    .refine((v) => Object.keys(v).length <= 64),
});
const configCommand = z
  .object({
    template: z.string().max(65536),
    description: z.string().max(2048).default(""),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  .passthrough();
const config = z
  .object({
    command: z.record(PaletteName, z.unknown()).default({}),
    agent: z.record(PaletteName, z.unknown()).default({}),
  })
  .passthrough();
const diagnostic = (source: string): ParsedSource => ({
  commands: [],
  diagnostics: [{ source, message: "Invalid command metadata or document" }],
});
function definition(ctx: ParseContext, body: string, raw: Record<string, unknown>): Definition {
  const meta = providerMeta.parse(raw);
  const lib = ctx.format === "library" ? libraryMeta.parse(raw) : undefined;
  const name = PaletteName.parse(
    ctx.skill || ctx.kind === "agent" || lib ? (meta.name ?? ctx.name) : ctx.name,
  );
  return {
    id: `${ctx.source}#${name}`,
    extension: {
      id: `${ctx.source}#${name}`,
      kind: ctx.kind ?? (ctx.skill ? "skill" : "command"),
      name: ctx.plugin ? `${ctx.plugin}:${name}` : name,
      description: meta.description,
      source: {
        provider: ctx.format === "library" ? "ace" : ctx.format,
        scope: ctx.plugin ? "plugin" : ctx.scope === "workspace" ? "project" : "global",
        ...(ctx.path ? { path: ctx.path } : {}),
        ...(ctx.plugin ? { plugin: ctx.plugin } : {}),
      },
      invocation:
        ctx.kind === "agent"
          ? { type: "agent", name: ctx.plugin ? `${ctx.plugin}:${name}` : name }
          : ctx.skill &&
              (ctx.format === "codex" || ctx.format === "opencode" || ctx.format === "cursor") &&
              ctx.path
            ? { type: "skill", name, path: ctx.path }
            : ctx.format === "codex" ||
                ctx.format === "library" ||
                (["pi", "cursor"].includes(ctx.format) && !ctx.skill)
              ? {
                  type: "prompt",
                  commandId: `${ctx.source}#${name}`,
                  ...(lib ? { parameters: lib.arguments } : {}),
                }
              : {
                  type: "slash",
                  name: ctx.plugin
                    ? `${ctx.plugin}:${name}`
                    : ctx.format === "pi" && ctx.skill
                      ? `skill:${name}`
                      : name,
                },
    },
    name,
    description: meta.description,
    namespace: lib ? "prompt" : "provider",
    provider: lib?.provider ?? (ctx.format === "library" ? "any" : ctx.format),
    arguments: lib?.arguments ?? {},
    scope: ctx.scope,
    body,
    format: ctx.format,
    raw,
    ...(ctx.instance === undefined ? {} : { instance: ctx.instance }),
    ...(meta["argument-hint"] === undefined ? {} : { argumentHint: meta["argument-hint"] }),
    ...(meta["user-invocable"] === false ? { unavailable: true } : {}),
    priority:
      ctx.format === "claude" && ctx.skill
        ? ctx.scope === "user"
          ? 22
          : 21
        : (ctx.scope === "workspace" ? 20 : 10) + (ctx.skill ? 1 : 0),
    nativeName:
      ctx.format === "codex" && !ctx.skill && ctx.kind !== "agent"
        ? `prompts:${name}`
        : ctx.plugin
          ? `${ctx.plugin}:${name}`
          : name,
  };
}
export function parseMarkdown(text: string, ctx: ParseContext): ParsedSource {
  if (Buffer.byteLength(text) > 65536) return diagnostic(ctx.source);
  try {
    let body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    let raw: Record<string, unknown> = {};
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---", 3);
      if (end < 0 || !/^\n---(?:\n|$)/.test(body.slice(end))) return diagnostic(ctx.source);
      const doc = parseDocument(body.slice(4, end), { uniqueKeys: true });
      if (doc.errors.length) return diagnostic(ctx.source);
      raw = z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 20 }) ?? {});
      body = body.slice(end + 4).replace(/^\n/, "");
    }
    return { commands: [definition(ctx, body, raw)], diagnostics: [] };
  } catch {
    return diagnostic(ctx.source);
  }
}
export function parseOpenCodeConfig(text: string, ctx: Omit<ParseContext, "format">): ParsedSource {
  if (Buffer.byteLength(text) > 65536) return diagnostic(ctx.source);
  try {
    const errors: ParseError[] = [];
    const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length) return diagnostic(ctx.source);
    const parsed = config.parse(raw);
    const result: ParsedSource = { commands: [], diagnostics: [] };
    for (const [name, value] of Object.entries(parsed.command).slice(0, 256)) {
      const item = configCommand.safeParse(value);
      if (!item.success) {
        result.diagnostics.push(...diagnostic(`${ctx.source}#${name}`).diagnostics);
        continue;
      }
      result.commands.push(
        definition({ ...ctx, name, format: "opencode" }, item.data.template, item.data),
      );
    }
    for (const [name, value] of Object.entries(parsed.agent).slice(0, 256)) {
      const agent = z
        .object({
          description: z.string().max(2048).default(""),
          disable: z.boolean().default(false),
        })
        .passthrough()
        .safeParse(value);
      if (agent.success && !agent.data.disable)
        result.commands.push(
          definition({ ...ctx, name, format: "opencode", kind: "agent" }, "", agent.data),
        );
    }
    if (Object.keys(parsed.command).length > 256)
      result.diagnostics.push({ source: ctx.source, message: "Command count limit exceeded" });
    return result;
  } catch {
    return diagnostic(ctx.source);
  }
}

export function parseCodexAgent(text: string, ctx: Omit<ParseContext, "format">): ParsedSource {
  if (Buffer.byteLength(text) > 65536) return diagnostic(ctx.source);
  try {
    const raw = z.record(z.string(), z.unknown()).parse(parseToml(text));
    return {
      commands: [definition({ ...ctx, format: "codex", kind: "agent" }, "", raw)],
      diagnostics: [],
    };
  } catch {
    return diagnostic(ctx.source);
  }
}
