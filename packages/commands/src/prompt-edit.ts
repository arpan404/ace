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
    description: z.string().nullish(),
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
  const { header, body } = splitPrompt(text);
  if (header === undefined && Object.keys(patch).every((key) => key === "body"))
    return patch.body ?? body;
  const doc = parseDocument(header ?? "", { uniqueKeys: true });
  if (doc.errors.length) throw new Error("invalid_frontmatter");
  for (const key of ["name", "description", "provider"] as const) {
    const value = patch[key];
    if (key === "name" && value === "") doc.delete(key);
    else if (value !== undefined) doc.set(key, value);
  }
  return `---\n${doc.toString()}---\n${patch.body ?? body}`;
}
