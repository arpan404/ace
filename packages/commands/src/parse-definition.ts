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
export const diagnostic = (source: string): ParsedSource => ({
  commands: [],
  diagnostics: [{ source, message: "Invalid command metadata or document" }],
});
export function definition(
  ctx: ParseContext,
  body: string,
  raw: Record<string, unknown>,
): Definition {
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
