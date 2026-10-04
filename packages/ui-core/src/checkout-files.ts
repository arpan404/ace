/*
 * Files of a thread's checkout as the Files tool shows them: relative paths, the tree built
 * from whichever paths are known, which language highlights a file, and whether bytes are text.
 * Pure, so the web and mobile clients share one rule.
 */

/** A relative path inside a checkout: no root, no `..`, no backslashes, no empty segments. */
export function isCheckoutPath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** "apps/web/main.ts" → name "main.ts", folder "apps/web". A folder path ends in "/". */
export function pathParts(path: string): { name: string; folder: string; segments: string[] } {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = trimmed.split("/").filter(Boolean);
  return {
    name: segments.at(-1) ?? "",
    folder: segments.slice(0, -1).join("/"),
    segments,
  };
}

const languages: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  py: "python",
  sh: "sh",
  bash: "bash",
  zsh: "zsh",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "cs",
};

/** The highlighter's language for a file, from its extension; undefined shows it plain. */
export function fileLanguage(path: string): string | undefined {
  const name = pathParts(path).name.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? languages[name.slice(dot + 1)] : undefined;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

const images: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** The image type a viewer can draw for this file, if it is one. */
export function imageType(path: string): string | undefined {
  const name = pathParts(path).name.toLowerCase();
  return images[name.slice(name.lastIndexOf(".") + 1)];
}

/**
 * Whether bytes read as text: no NUL in the first 8 KiB and valid UTF-8 throughout. `partial`
 * says more bytes follow, so a code point cut at the end is not counted against it.
 */
export function isText(bytes: Uint8Array, partial = false): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
    return true;
  } catch {
    return false;
  }
}

export interface FileTreeNode {
  /** The node's path; a folder's ends in "/". */
  path: string;
  name: string;
  kind: "folder" | "file";
  children: FileTreeNode[];
}

const byName = (a: FileTreeNode, b: FileTreeNode) =>
  a.kind === b.kind
    ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
    : a.kind === "folder"
      ? -1
      : 1;

/**
 * A tree from known paths (files, and folders ending in "/"): folders before files, each sorted
 * by name. Folders appear for every file's parents; invalid paths are left out.
 */
export function buildFileTree(paths: Iterable<string>): FileTreeNode[] {
  const root: FileTreeNode = { path: "", name: "", kind: "folder", children: [] };
  const folders = new Map<string, FileTreeNode>([["", root]]);
  const folder = (path: string): FileTreeNode => {
    const known = folders.get(path);
    if (known) return known;
    const parts = pathParts(path);
    const node: FileTreeNode = { path, name: parts.name, kind: "folder", children: [] };
    folders.set(path, node);
    folder(parts.folder ? `${parts.folder}/` : "").children.push(node);
    return node;
  };
  const files = new Set<string>();
  for (const path of paths) {
    if (!isCheckoutPath(path)) continue;
    if (path.endsWith("/")) {
      folder(path);
      continue;
    }
    if (files.has(path)) continue;
    files.add(path);
    const parts = pathParts(path);
    folder(parts.folder ? `${parts.folder}/` : "").children.push({
      path,
      name: parts.name,
      kind: "file",
      children: [],
    });
  }
  const sort = (node: FileTreeNode) => {
    node.children.sort(byName);
    for (const child of node.children) sort(child);
  };
  sort(root);
  return root.children;
}

export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
}

/** The rows a tree shows: every node under an expanded folder, depth first. */
export function treeRows(
  nodes: readonly FileTreeNode[],
  isExpanded: (folder: string) => boolean,
  depth = 0,
  out: FileTreeRow[] = [],
): FileTreeRow[] {
  for (const node of nodes) {
    const expanded = node.kind === "folder" && isExpanded(node.path);
    out.push({ node, depth, expanded });
    if (expanded) treeRows(node.children, isExpanded, depth + 1, out);
  }
  return out;
}

/** Every folder above `path` ("a/b/c.ts" → "a/", "a/b/"), to reveal it in a tree. */
export function ancestorFolders(path: string): string[] {
  const { segments } = pathParts(path);
  const out: string[] = [];
  for (let index = 1; index < segments.length; index++)
    out.push(`${segments.slice(0, index).join("/")}/`);
  return out;
}

/**
 * Where `query`'s characters fall in `path`, in order, for highlighting a fuzzy match; the file
 * name is tried first so "cfg" lights up "config.ts" rather than a folder. Undefined when the
 * characters don't all appear in order.
 */
export function fuzzyPositions(query: string, path: string): number[] | undefined {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return [];
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf("/", path.length - 2) + 1;
  const scan = (from: number): number[] | undefined => {
    const positions: number[] = [];
    let at = from;
    for (const char of needle) {
      const next = haystack.indexOf(char, at);
      if (next < 0) return undefined;
      positions.push(next);
      at = next + 1;
    }
    return positions;
  };
  return scan(nameStart) ?? scan(0);
}

/**
 * The files someone opened most recently, newest first, each once, at most `limit`. `path` moves
 * to the front.
 */
export function rememberRecent(recent: readonly string[], path: string, limit = 20): string[] {
  return [path, ...recent.filter((each) => each !== path)].slice(0, limit);
}
