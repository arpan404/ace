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
