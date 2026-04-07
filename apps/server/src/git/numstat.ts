export interface GitNumstatEntry {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export function parseNumstatEntries(stdout: string, truncated = false): Array<GitNumstatEntry> {
  const normalized =
    truncated && !stdout.endsWith("\n")
      ? stdout.slice(0, Math.max(0, stdout.lastIndexOf("\n")))
      : stdout;
  const entries: Array<GitNumstatEntry> = [];

  for (const line of normalized.split(/\r?\n/g)) {
    if (line.trim().length === 0) {
      continue;
    }

    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) {
      continue;
    }

    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;

    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }

  return entries;
}
