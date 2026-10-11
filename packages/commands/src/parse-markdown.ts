import { splitPrompt } from "./prompt-edit.ts";
export { promptFields, updatePrompt } from "./prompt-edit.ts";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { ParsedSource, ParseContext } from "./types.ts";
import { definition, diagnostic } from "./parse-definition.ts";

export function parseMarkdown(text: string, ctx: ParseContext): ParsedSource {
  if (new TextEncoder().encode(text).byteLength > 65536)
    return diagnostic(ctx.source, "This prompt is too large. Keep it under 64 KB before saving.");
  try {
    const { header, body } = splitPrompt(text);
    let raw: Record<string, unknown> = {};
    if (header !== undefined) {
      const doc = parseDocument(header, { uniqueKeys: true });
      if (doc.errors.length)
        return diagnostic(
          ctx.source,
          "The settings at the top of this prompt have invalid syntax. Check the names, brackets and indentation.",
        );
      raw = z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 20 }) ?? {});
    }
    return { commands: [definition(ctx, body, raw)], diagnostics: [] };
  } catch (error) {
    if (error instanceof Error && error.message === "missing_frontmatter_end")
      return diagnostic(
        ctx.source,
        "The settings at the top of this prompt need a closing --- line. Add it before the prompt text.",
      );
    return diagnostic(
      ctx.source,
      "A prompt setting or argument has an unsupported value. Check the names and values at the top of the file.",
    );
  }
}
