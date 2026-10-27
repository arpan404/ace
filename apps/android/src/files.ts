import { readFile } from "@ace/client";
import type { ClientApi, ServiceRequest } from "@ace/client";
import { downloadFile } from "@ace/client/files";
import { ItemId, ThreadId, WorkspaceId } from "@ace/protocol";
import {
  ancestorFolders,
  buildFileTree,
  changeLetters,
  checkoutTreeRows,
  checkoutViewLimit,
  fileLanguage,
  fuzzyPositions,
  imageType,
  isCheckoutPath,
  isMarkdownPath,
  isText,
  pathParts,
} from "@ace/ui-core";
import { checkoutLinkPath, localLinkLine, localLinkPath } from "@ace/ui-core/file-references";

/*
 * Android file viewing: a thread checkout's tree and one file at a time, read-only.
 * Mutations (edit/create/rename/move/delete/restore) are out of scope; the viewer never
 * sends them. Presentation state lives in `Files.tsx`; this module owns data + pure rules.
 */

export type FilesScope = { threadId: string } | { workspaceId: string };

/** What file viewing needs of a client: `ClientApi`, or `ClientCore` in tests. */
export type FilesClient = Pick<ClientApi, "state" | "connectionState" | "request" | "send"> & {
  onMessage: ClientApi["onMessage"];
  cachedThread?: ClientApi["cachedThread"];
};

type FilesOperation = Extract<ServiceRequest, { type: "files.request" }>["operation"];

export interface FileTreeRowView {
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  mark?: string;
  markLabel?: string;
}

export interface FileTreeView {
  rows: FileTreeRowView[];
  /** Folders that start open: the ones holding an uncommitted change. */
  open: string[];
  truncated: boolean;
}

export interface FileSearchRowView {
  path: string;
  name: string;
  folder: string;
  isFolder: boolean;
  positions: number[];
}

export type FileContentView =
  | {
      kind: "text";
      path: string;
      size: number;
      version: string;
      text: string;
      markdown: boolean;
      language: string | undefined;
      marks: { line: number; kind: string }[];
    }
  | { kind: "image"; path: string; size: number; version: string; dataUri: string }
  | { kind: "large"; path: string; size: number; version: string }
  | { kind: "binary"; path: string; size: number; version: string }
  | { kind: "missing"; path: string }
  | { kind: "folder"; path: string };

export type FileLinkView =
  | { kind: "checkout"; path: string; line?: number }
  | { kind: "linked"; name: string }
  | { kind: "none" };

export interface FileBytesView {
  name: string;
  base64: string;
}

const quiet = { timeoutMs: 20_000 };
/** The most Share or a linked file carries to the phone. */
export const shareLimit = 16 * 1024 * 1024;

/** Rows under open folders, in tree order. */
export function visibleTreeRows(
  rows: readonly FileTreeRowView[],
  open: ReadonlySet<string>,
): FileTreeRowView[] {
  const out: FileTreeRowView[] = [];
  let closedDepth: number | undefined;
  for (const row of rows) {
    if (closedDepth !== undefined) {
      if (row.depth > closedDepth) continue;
      closedDepth = undefined;
    }
    out.push(row);
    if (row.folder && !open.has(row.path)) closedDepth = row.depth;
  }
  return out;
}

/** Every folder above `path`, to reveal it in the tree. */
export function revealFoldersFor(path: string): string[] {
  return ancestorFolders(path);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Strip git's C-style quoting from a `---`/`+++` path (`"a/my file.ts"` → `a/my file.ts`). */
function unquoteDiffPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return trimmed;
}

// Git quotes the whole `a/<path>` when it needs escaping (`"a/my file.ts"`),
// so unquote first and strip the side prefix after.
function sidePath(raw: string | undefined): string {
  const name = unquoteDiffPath(raw ?? "");
  return name.startsWith("a/") || name.startsWith("b/") ? name.slice(2) : name;
}

/**
 * Lines of `path` a unified diff touches: added lines by their new-file number, plus one
 * `removed` marker above each hunk that only deletes. Pure; mirrors the web's change bars.
 *
 * Only the `+++` (new-file) side decides ownership, so a rename marks its new path only.
 * A delete (`+++ /dev/null`) falls back to the `---` side. Header and binary lines never
 * move the line cursor; only hunks, additions, deletions and context do.
 */
export function parseChangedLines(patch: string, path: string): { line: number; kind: string }[] {
  const out: { line: number; kind: string }[] = [];
  const seen = new Set<string>();
  const push = (line: number, kind: string) => {
    const key = `${line}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, kind });
  };
  const files = patch.split(/^diff --git /m).slice(1);
  for (const file of files) {
    const minus = [...file.matchAll(/^--- (.+)$/gm)].map((match) => sidePath(match[1]));
    const plus = [...file.matchAll(/^\+\+\+ (.+)$/gm)].map((match) => sidePath(match[1]));
    const names = plus.length === 1 && plus[0] === "/dev/null" ? minus : plus;
    if (!names.includes(path)) continue;
    let current = 0;
    let hunkAdds = 0;
    let hunkDeletes = 0;
    for (const line of file.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        if (hunkDeletes > 0 && hunkAdds === 0) push(current, "removed");
        current = Number(hunk[1]);
        hunkAdds = 0;
        hunkDeletes = 0;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        push(current, "added");
        current += 1;
        hunkAdds += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        hunkDeletes += 1;
      } else if (line.startsWith(" ") || line === "") {
        current += 1;
      } else {
        // Headers (`---`/`+++`/`index`/`Binary files …`), modes and anything else
        // never move the cursor: only hunk content counts.
        continue;
      }
    }
    if (hunkDeletes > 0 && hunkAdds === 0) push(current, "removed");
  }
  return out.toSorted((a, b) => a.line - b.line);
}

/** Quick open over already-listed paths: no daemon round trip, fuzzy in name first. */
export function quickOpen(
  query: string,
  paths: readonly string[],
  limit = 50,
): FileSearchRowView[] {
  const needle = query.trim();
  if (!needle) return [];
  const out: FileSearchRowView[] = [];
  for (const path of paths) {
    if (!isCheckoutPath(path)) continue;
    const bare = path.endsWith("/") ? path.slice(0, -1) : path;
    const positions = fuzzyPositions(needle, bare);
    if (!positions) continue;
    const parts = pathParts(path);
    out.push({
      path,
      name: parts.name,
      folder: parts.folder,
      isFolder: path.endsWith("/"),
      positions,
    });
    if (out.length >= limit) break;
  }
  return out;
}

type WireScope = { threadId: ThreadId } | { workspaceId: WorkspaceId };

function wireScope(scope: FilesScope): WireScope {
  if ("threadId" in scope) return { threadId: ThreadId.parse(scope.threadId) };
  return { workspaceId: WorkspaceId.parse(scope.workspaceId) };
}

function serviceError(error: unknown): { code: string; message: string } {
  const code =
    error != null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "failed";
  const message =
    error != null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Couldn't reach the files. Try again.";
  return { code, message };
}

async function filesResult(
  client: FilesClient,
  scope: WireScope,
  operation: FilesOperation,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const reply = await client
    .request({ type: "files.request", ...scope, operation }, { ...quiet, signal })
    .catch((error: unknown) => {
      throw new Error(serviceError(error).message, { cause: error });
    });
  if (reply.type === "files.error") throw new Error(reply.code);
  if (reply.type !== "files.result") throw new Error("Couldn't read the reply. Try again.");
  return reply.value;
}

function parseListing(value: unknown): { paths: string[]; truncated: boolean } {
  if (value == null || typeof value !== "object")
    throw new Error("Couldn't read the reply. Try again.");
  const record = value as { paths?: unknown; truncated?: unknown };
  if (!Array.isArray(record.paths) || !record.paths.every((path) => typeof path === "string")) {
    throw new Error("Couldn't read the reply. Try again.");
  }
  return { paths: record.paths, truncated: record.truncated === true };
}

async function gitStatus(
  client: FilesClient,
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<{ path: string; status: string }[]> {
  try {
    const reply = await client.request(
      { type: "workspace.request", operation: { op: "git.status", threadId } },
      { ...quiet, signal },
    );
    const result = (reply as { result?: unknown }).result as
      | { kind?: unknown; files?: unknown }
      | undefined;
    if (result?.kind !== "gitStatus" || !Array.isArray(result.files)) return [];
    return (result.files as { path?: unknown; status?: unknown }[])
      .filter((file) => typeof file.path === "string" && typeof file.status === "string")
      .map((file) => ({ path: file.path as string, status: file.status as string }));
  } catch {
    // Marks are extra: a checkout whose git can't be read still lists its files.
    return [];
  }
}

async function gitDiff(
  client: FilesClient,
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const reply = await client.request(
      { type: "workspace.request", operation: { op: "git.diff", threadId } },
      { ...quiet, signal },
    );
    const result = (reply as { result?: unknown }).result as
      | { kind?: unknown; patch?: unknown }
      | undefined;
    return result?.kind === "gitDiff" && typeof result.patch === "string"
      ? result.patch
      : undefined;
  } catch {
    return undefined;
  }
}

// One `native.files`-style burst at a time per scope, as the web's checkout source does.
// A queued burst that aborts while waiting never runs; entries clear on settle so no
// resolved promise pins the scope forever.
const inFlight = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const previous = inFlight.get(key) ?? Promise.resolve();
  const next = previous.then(() => {
    signal.throwIfAborted();
    return run();
  });
  const tracked = next.catch(() => undefined);
  inFlight.set(key, tracked);
  const cleanup = () => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

export function scopeKey(scope: FilesScope): string {
  return "threadId" in scope ? `thread:${scope.threadId}` : `project:${scope.workspaceId}`;
}

/**
 * The checkout as rows in tree order: folders first, by name, each with the web's git
 * letter for uncommitted changes. One listing burst at a time; at most 1,000 entries.
 */
export async function listTree(
  client: FilesClient,
  scope: FilesScope,
  signal: AbortSignal,
): Promise<FileTreeView> {
  return serialized(scopeKey(scope), signal, async () => {
    const wire = wireScope(scope);
    const [listing, changes] = await Promise.all([
      filesResult(client, wire, { op: "list", path: "", limit: 1000 }, signal).then(parseListing),
      "threadId" in wire ? gitStatus(client, wire.threadId, signal) : Promise.resolve([]),
    ]);
    const status = new Map(changes.map((change) => [change.path, change.status]));
    const deleted = changes
      .filter((change) => change.status === "deleted")
      .map((change) => change.path);
    const tree = buildFileTree([...listing.paths, ...deleted]);
    const rows: FileTreeRowView[] = checkoutTreeRows(tree, () => true).map(({ node, depth }) => {
      const change = status.get(node.path);
      const letter =
        change !== undefined ? changeLetters[change as keyof typeof changeLetters] : undefined;
      const view: FileTreeRowView = {
        path: node.path,
        name: node.name,
        depth,
        folder: node.kind === "folder",
      };
      if (letter) {
        view.mark = letter.letter;
        view.markLabel = letter.label;
      }
      return view;
    });
    const open = new Set<string>();
    for (const change of changes)
      for (const folder of ancestorFolders(change.path)) open.add(folder);
    return { rows, open: [...open], truncated: listing.truncated };
  });
}

/** Read one file as the viewer shows it. Never sends a mutation. */
export async function readFileContent(
  client: FilesClient,
  scope: FilesScope,
  path: string,
  signal: AbortSignal,
): Promise<FileContentView> {
  if (!isCheckoutPath(path)) throw new Error("This path is outside the checkout.");
  const wire = wireScope(scope);
  const read = await readFile(
    client,
    { ...wire, path, maxSize: checkoutViewLimit },
    { ...quiet, signal },
  ).catch((error: unknown) => {
    throw new Error(serviceError(error).message, { cause: error });
  });
  if (read.kind === "missing") return { kind: "missing", path };
  if (read.kind === "folder") return { kind: "folder", path };
  // `readFile` returns full bytes or `large`: for a file, its bytes are the size.
  const size = read.kind === "large" ? read.size : read.bytes.length;
  if (read.kind === "large") {
    return { kind: "large", path, size, version: read.version };
  }
  const bytes = read.bytes;
  const image = imageType(path);
  if (image && image !== "image/svg+xml") {
    return {
      kind: "image",
      path,
      size,
      version: read.version,
      dataUri: `data:${image};base64,${encodeBase64(bytes)}`,
    };
  }
  if (!isText(bytes)) return { kind: "binary", path, size, version: read.version };
  const text = new TextDecoder().decode(bytes);
  const marks =
    "threadId" in wire
      ? await gitDiff(client, wire.threadId, signal).then((patch) =>
          patch
            ? parseChangedLines(patch, path).map(({ line, kind }) => ({
                line,
                kind: kind === "added" ? "added" : "removed",
              }))
            : [],
        )
      : [];
  return {
    kind: "text",
    path,
    size,
    version: read.version,
    text,
    markdown: isMarkdownPath(path),
    language: fileLanguage(path),
    marks,
  };
}

/**
 * Where a message's local link lands: a checkout file (opened at its line), or a file
 * outside the checkout only the host can serve because this message links it.
 */
export function resolveMessageLink(
  target: string,
  options: { root: string | undefined; cwd: string | undefined },
): FileLinkView {
  const local = localLinkPath(target);
  if (!local) return { kind: "none" };
  const relative = checkoutLinkPath(local, options.root, options.cwd);
  const line = localLinkLine(target);
  if (relative && isCheckoutPath(relative))
    return { kind: "checkout", path: relative, ...(line ? { line } : {}) };
  return { kind: "linked", name: pathParts(local).name || "the file" };
}

export function threadFileContext(
  client: FilesClient,
  threadId: string,
): {
  root: string | undefined;
  agentCwd: (agentId: string | undefined) => string | undefined;
} {
  const snapshot = client.cachedThread?.(threadId) as
    | {
        thread?: { details?: { worktree?: string; workspace?: { path?: string } } };
        item?: (id: string) => { agentId?: string } | undefined;
        agent?: (id: string) => { cwd?: string } | undefined;
      }
    | undefined;
  const root = snapshot?.thread?.details?.worktree ?? snapshot?.thread?.details?.workspace?.path;
  return {
    root,
    agentCwd: (agentId) => (agentId ? snapshot?.agent?.(agentId)?.cwd : undefined),
  };
}

/** A file's bytes (≤16 MB) for Share or an out-of-checkout Quick Look. */
export async function downloadCopy(
  client: FilesClient,
  scope: FilesScope,
  operation:
    | { op: "download"; path: string }
    | { op: "link.download"; itemId: string; reference: string },
  signal: AbortSignal,
): Promise<FileBytesView> {
  const wire = wireScope(scope);
  const download =
    operation.op === "link.download"
      ? { ...wire, ...operation, itemId: ItemId.parse(operation.itemId), offset: 0 }
      : { ...wire, ...operation, offset: 0 };
  const chunks = downloadFile(client, download, { ...quiet, signal });
  const bytes = await gatherCapped(chunks, shareLimit);
  const name =
    operation.op === "download"
      ? pathParts(operation.path).name || "file"
      : pathParts(operation.reference).name || "file";
  return { name, base64: encodeBase64(bytes) };
}

async function gatherCapped(source: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit) throw new Error("This file is over 16 MB. Get it on your computer.");
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] ?? 0;
    const b = at + 1 < bytes.length ? (bytes[at + 1] ?? 0) : 0;
    const c = at + 2 < bytes.length ? (bytes[at + 2] ?? 0) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += base64Alphabet.charAt((triple >> 18) & 63) + base64Alphabet.charAt((triple >> 12) & 63);
    out += at + 1 < bytes.length ? base64Alphabet.charAt((triple >> 6) & 63) : "=";
    out += at + 2 < bytes.length ? base64Alphabet.charAt(triple & 63) : "=";
  }
  return out;
}

/**
 * Tell Files screens to read again when any checkout changes on the host (a create, save
 * or delete from any device), as the web drops its checkout reads then.
 */
export function followFileChanges(client: FilesClient, onChanged: () => void): () => void {
  return client.onMessage((message) => {
    if (message.type === "files.changed") {
      onChanged();
      return;
    }
    if (message.type === "events" && Array.isArray((message as { events?: unknown }).events)) {
      const events = (message as { events: { payload?: { type?: unknown } }[] }).events;
      if (events.some((event) => event.payload?.type === "workspace.files_changed")) onChanged();
    }
  });
}
