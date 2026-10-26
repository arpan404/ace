import { parseDocument } from "yaml";
import { z } from "zod";
import { editFrontmatter, splitPrompt } from "./prompt-edit.ts";

/** SKILL.md files the library reads or writes, like plugin source edits. */
export const skillFileLimit = 256 * 1024;
export interface SkillMarkdown {
  name?: string;
  title?: string;
  description: string;
  manual: boolean;
  argumentHint?: string;
}
const Fields = z
  .object({
    name: z.unknown(),
    description: z.unknown(),
    "disable-model-invocation": z.unknown(),
    "argument-hint": z.unknown(),
  })
  .partial()
  .passthrough();
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
/** Lenient: unreadable frontmatter still lists the skill, with an empty description. */
export function parseSkill(source: string): SkillMarkdown {
  let header: string | undefined;
  let body: string;
  try {
    ({ header, body } = splitPrompt(source));
  } catch {
    return { description: "", manual: false };
  }
  let fields: z.infer<typeof Fields> = {};
  try {
    const doc = parseDocument(header ?? "", { uniqueKeys: false });
    const parsed = Fields.safeParse(
      doc.errors.length ? {} : (doc.toJS({ maxAliasCount: 20 }) ?? {}),
    );
    if (parsed.success) fields = parsed.data;
  } catch {
    /* Keep the empty defaults. */
  }
  const name = text(fields.name, 256);
  // Only a leading heading is a title (ADR 0014).
  const title = text(/^#[ \t]+(.+)$/.exec(body.trimStart().split("\n", 1)[0] ?? "")?.[1], 256);
  const hint = text(fields["argument-hint"], 1024);
  return {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    description: text(fields.description, 2048) ?? "",
    manual:
      fields["disable-model-invocation"] === true || fields["disable-model-invocation"] === "true",
    ...(hint ? { argumentHint: hint } : {}),
  };
}
/** A new skill's SKILL.md. */
export function newSkill(name: string, description: string, body: string, manual: boolean): string {
  return editFrontmatter(
    "---\n---\n",
    { name, description, "disable-model-invocation": manual ? true : undefined },
    body,
  );
}
/** Edit description, body and manual; every other key and comment is kept. */
export function editSkill(
  source: string,
  patch: { description: string; body: string; manual: boolean },
): string {
  return editFrontmatter(
    source,
    {
      description: patch.description,
      "disable-model-invocation": patch.manual ? true : null,
    },
    patch.body,
  );
}
