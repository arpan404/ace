import { z } from "zod";
import type { ForgeErrorKind } from "./errors.ts";

const detail = z.looseObject({
  resource: z.string().max(256).optional(),
  field: z.string().max(256).optional(),
  code: z.string().max(256).optional(),
  message: z.string().max(4096).optional(),
});
const validation = z.looseObject({
  message: z.string().max(4096).optional(),
  errors: z
    .array(z.union([z.string().max(4096), detail]))
    .max(100)
    .optional(),
});

/** GitHub's 422 body names the refused field or explains the refusal; map it to fixed codes. */
export function unprocessableKind(text: string): ForgeErrorKind {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "unprocessable";
  }
  const parsed = validation.safeParse(body);
  if (!parsed.success) return "unprocessable";
  const entries = (parsed.data.errors ?? []).map((entry) =>
    typeof entry === "string" ? { message: entry } : entry,
  );
  const messages = [parsed.data.message ?? "", ...entries.map((entry) => entry.message ?? "")];
  if (messages.some((message) => /no commits between/i.test(message))) return "no_commits";
  if (messages.some((message) => /pull request already exists/i.test(message))) return "pr_exists";
  if (entries.some((entry) => entry.field === "head" && entry.code === "invalid"))
    return "head_missing";
  if (entries.some((entry) => entry.field === "base" && entry.code === "invalid"))
    return "base_missing";
  // Name collisions (repositories, labels) stay a conflict with the existing resource.
  if (
    entries.some(
      (entry) => entry.code === "already_exists" || /already exists/i.test(entry.message ?? ""),
    )
  )
    return "conflict";
  return "unprocessable";
}

/** gh documents exit code 4 for "authentication required"; it fails before any request. */
export const ghAuthRequiredExit = 4;

const graphqlPath = z.array(z.union([z.string().max(256), z.number().int()])).max(32);

/**
 * A query may return partial data: `null` at a field plus a NOT_FOUND error naming that
 * field's path. Only such errors are tolerable; the caller decodes the null as "missing".
 */
export function onlyMissingFields(
  data: Record<string, unknown> | null | undefined,
  errors: readonly { type?: string | undefined; path?: unknown }[],
): boolean {
  if (!data) return false;
  return errors.every((error) => {
    if (error.type !== "NOT_FOUND") return false;
    const path = graphqlPath.safeParse(error.path);
    if (!path.success || path.data.length === 0) return false;
    let value: unknown = data;
    for (const key of path.data) {
      if (value === null || typeof value !== "object") return false;
      const next: unknown = Reflect.get(value, key);
      value = next;
    }
    return value === null;
  });
}
