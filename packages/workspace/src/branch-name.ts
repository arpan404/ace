/** Git-safe branch name, including prefix and collision suffix, capped at 40 characters. */
export function worktreeBranchName(title: string, occurrence = 1): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-thread";
  const suffix = occurrence > 1 ? `-${occurrence}` : "";
  return `ace/${slug.slice(0, 36 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/**
 * Slug budget for model-generated branch names. `ace/` (4) plus this plus a `-256`
 * collision suffix (4) stays within the 40-character branch cap, keeping names concise.
 */
export const worktreeBranchSlugMaxChars = 28;

/**
 * A model's reply as a branch slug (without the `ace/` prefix), or undefined when it
 * offers nothing usable. Sanitized to lowercase hyphen-joined words, capped to 4 words
 * and `worktreeBranchSlugMaxChars` characters so the final `ace/<slug>` plus any
 * collision suffix stays within the branch cap. Falls back to the title slug when this
 * returns undefined.
 */
export function generatedBranchSlug(reply: string): string | undefined {
  const line = reply
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return undefined;
  const cleaned = line
    .replace(/^branch\s*:\s*/i, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.!,?;:]+$/, "")
    .trim()
    .replace(/^ace\//i, "");
  const slug =
    cleaned
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "";
  if (!slug || slug === "new-thread" || slug === "new") return undefined;
  const words = slug.split("-").filter(Boolean).slice(0, 4);
  if (words.length === 0) return undefined;
  const short = words.join("-").slice(0, worktreeBranchSlugMaxChars).replace(/-+$/g, "");
  if (!short || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(short)) return undefined;
  return short;
}
