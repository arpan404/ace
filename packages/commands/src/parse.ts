import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { PaletteName } from "@ace/protocol";
import type { ParsedSource, ParseContext } from "./types.ts";
import { definition, diagnostic } from "./parse-definition.ts";
export { parseMarkdown } from "./parse-markdown.ts";

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
export function parseOpenCodeConfig(text: string, ctx: Omit<ParseContext, "format">): ParsedSource {
  if (new TextEncoder().encode(text).byteLength > 65536) return diagnostic(ctx.source);
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
  if (new TextEncoder().encode(text).byteLength > 65536) return diagnostic(ctx.source);
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
