import type { Entry, FileKind, PageReply } from "@ace/files-native";
import type { FolderEntry, FolderPage } from "@ace/protocol";

/** What a symlink points at, followed through further links to the kind a person sees. */
function linkTarget(kind: FileKind | undefined): FolderEntry["target"] {
  let current = kind;
  while (current?.type === "symlink") current = current.target;
  return current?.type ?? undefined;
}

/** One ace-files entry in the client protocol's terms. */
export function folderEntry(entry: Entry): FolderEntry {
  const base = {
    name: entry.name,
    path: entry.path,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ignored: entry.ignored,
  };
  if (entry.kind.type !== "symlink") return { ...base, kind: entry.kind.type };
  const target = linkTarget(entry.kind.target);
  return { ...base, kind: "symlink", ...(target ? { target } : {}) };
}

/** One listing page in the client protocol's terms; the last page says `nextCursor: null`. */
export function folderPage(page: PageReply): FolderPage {
  return {
    entries: page.entries.map(folderEntry),
    nextCursor: page.nextCursor ?? null,
    total: page.total,
  };
}
