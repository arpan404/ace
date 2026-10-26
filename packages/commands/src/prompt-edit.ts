import { parseDocument } from "yaml";
import { z } from "zod";

/** Shared frontmatter boundary. Preserve the source header while editing only its body. */
export function splitPrompt(text: string): { header?: string; body: string } {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!clean.startsWith("---\n")) return { body: clean };
  const end = clean.indexOf("\n---", 3);
  if (end < 0 || !/^\n---(?:\n|$)/.test(clean.slice(end)))
    throw new Error("missing_frontmatter_end");
  return { header: clean.slice(4, end), body: clean.slice(end + 4).replace(/^\n/, "") };
}
const Fields = z
  .object({
    name: z.string().optional(),
    // Not .nullish(): browser worker builds drop it, and parse-markdown loads this module there.
    description: z.string().nullable().optional(),
    provider: z.string().optional(),
  })
  .passthrough();
export function promptFields(text: string) {
  try {
    const { header, body } = splitPrompt(text);
    const doc = parseDocument(header ?? "", { uniqueKeys: true });
    if (doc.errors.length) return undefined;
    const parsed = Fields.safeParse(doc.toJS({ maxAliasCount: 20 }) ?? {});
    return parsed.success
      ? {
          name: parsed.data.name ?? "",
          description: parsed.data.description ?? "",
          provider: parsed.data.provider ?? "any",
          body,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
/** YAML's document editor preserves unknown keys and comments. Native provider values are opaque. */
export function updatePrompt(
  text: string,
  patch: Partial<{ name: string; description: string; provider: string; body: string }>,
): string {
  const { body, ...fields } = patch;
  return editFrontmatter(
    text,
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        key === "name" && value === "" ? null : value,
      ]),
    ),
    body,
  );
}
/**
 * Set (`value`), delete (`null`) or keep (`undefined`) frontmatter keys, and optionally replace
 * the body. Unknown keys, comments and key order survive.
 */
export function editFrontmatter(
  text: string,
  keys: Readonly<Record<string, string | boolean | null | undefined>>,
  replacement?: string,
): string {
  const { header, body } = splitPrompt(text);
  const changes = Object.entries(keys).filter(([, value]) => value !== undefined);
  if (header === undefined && changes.length === 0) return replacement ?? body;
  const doc = parseDocument(header ?? "", { uniqueKeys: true });
  if (doc.errors.length) throw new Error("invalid_frontmatter");
  for (const [key, value] of changes) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  return `---\n${doc.toString()}---\n${replacement ?? body}`;
}
