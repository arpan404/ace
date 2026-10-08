import { parseDocument } from "yaml";
import { z } from "zod";
import type { ParsedSource, ParseContext } from "./types.ts";
import { definition, diagnostic } from "./parse-definition.ts";

export function parseMarkdown(text: string, ctx: ParseContext): ParsedSource {
  if (new TextEncoder().encode(text).byteLength > 65536)
    return diagnostic(ctx.source, "This prompt is too large. Keep it under 64 KB before saving.");
  try {
    let body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    let raw: Record<string, unknown> = {};
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---", 3);
      if (end < 0 || !/^\n---(?:\n|$)/.test(body.slice(end)))
        return diagnostic(
          ctx.source,
          "The settings at the top of this prompt need a closing --- line. Add it before the prompt text.",
        );
      const doc = parseDocument(body.slice(4, end), { uniqueKeys: true });
      if (doc.errors.length)
        return diagnostic(
          ctx.source,
          "The settings at the top of this prompt have invalid syntax. Check the names, brackets and indentation.",
        );
      raw = z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 20 }) ?? {});
      body = body.slice(end + 4).replace(/^\n/, "");
    }
    return { commands: [definition(ctx, body, raw)], diagnostics: [] };
  } catch {
    return diagnostic(
      ctx.source,
      "A prompt setting or argument has an unsupported value. Check the names and values at the top of the file.",
    );
  }
}
