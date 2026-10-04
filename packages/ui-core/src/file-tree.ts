/*
 * The changed files of a review as a directory tree: folders first, then files, each sorted by
 * name; a folder holding nothing but one folder joins it ("apps/server/src"), and every folder
 * sums the lines its files gained and lost. `treeRows` flattens it to the rows a list shows,
 * honouring collapsed folders and a filter. Pure.
 */

export interface TreeFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface TreeFolderRow {
  kind: "folder";
  /** The folder's path from the root ("apps/server/src"); also its collapse key. */
  key: string;
  /** What the row shows: one segment, or joined segments for a chain ("server/src"). */
  name: string;
  depth: number;
  additions: number;
  deletions: number;
  /** Files at any depth below it. */
  files: number;
  open: boolean;
}

export interface TreeFileRow {
  kind: "file";
  key: string;
  name: string;
  depth: number;
  additions: number;
  deletions: number;
  /** Where the file sits in the list it was given, to jump to its diff. */
  index: number;
}

export type TreeRow = TreeFolderRow | TreeFileRow;

interface Folder {
  folders: Map<string, Folder>;
  files: { name: string; file: TreeFile; index: number }[];
}

const emptyFolder = (): Folder => ({ folders: new Map(), files: [] });
const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function build(files: readonly TreeFile[]): Folder {
  const root = emptyFolder();
  files.forEach((file, index) => {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.pop() ?? file.path;
    let folder = root;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = emptyFolder()));
      folder = next;
    }
    folder.files.push({ name, file, index });
  });
  return root;
}

function totals(folder: Folder): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  let files = folder.files.length;
  for (const { file } of folder.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  for (const child of folder.folders.values()) {
    const sum = totals(child);
    additions += sum.additions;
    deletions += sum.deletions;
    files += sum.files;
  }
  return { additions, deletions, files };
}

export interface TreeOptions {
  /** Folder keys the person collapsed. Ignored while filtering, so every match shows. */
  collapsed?: ReadonlySet<string>;
  /** Case-insensitive text every shown file's path contains. */
  filter?: string;
}

export function treeRows(files: readonly TreeFile[], options: TreeOptions = {}): TreeRow[] {
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const shown = needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
  const collapsed = needle ? new Set<string>() : (options.collapsed ?? new Set<string>());
  const indexOf = new Map(files.map((file, index) => [file, index]));
  const root = build(shown);
  const rows: TreeRow[] = [];
  const walk = (folder: Folder, prefix: string, depth: number) => {
    for (const [segment, child] of [...folder.folders].toSorted(([a], [b]) => byName(a, b))) {
      let name = segment;
      let key = prefix ? `${prefix}/${segment}` : segment;
      let node = child;
      // Join a chain of folders that hold nothing but the next folder.
      while (!node.files.length && node.folders.size === 1) {
        const [[next, only]] = [...node.folders] as [[string, Folder]];
        name = `${name}/${next}`;
        key = `${key}/${next}`;
        node = only;
      }
      const open = !collapsed.has(key);
      rows.push({ kind: "folder", key, name, depth, open, ...totals(node) });
      if (open) walk(node, key, depth + 1);
    }
    for (const entry of folder.files.toSorted((a, b) => byName(a.name, b.name)))
      rows.push({
        kind: "file",
        key: entry.file.path,
        name: entry.name,
        depth,
        additions: entry.file.additions,
        deletions: entry.file.deletions,
        index: indexOf.get(entry.file) ?? entry.index,
      });
  };
  walk(root, "", 0);
  return rows;
}
