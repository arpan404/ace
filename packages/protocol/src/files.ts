import { z } from "zod";
import { ItemId, ThreadId, WorkspaceId } from "./ids.ts";

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z.string().max(4096);
const id = z.string().min(1).max(128);
export const FileVersion = z.string().min(1).max(256);
const expected = FileVersion.nullable();
/** The most one `read` returns: big enough for most source files, small enough to share a link. */
export const FILE_READ_PART = 256 * 1024;
/** The most matches one content search reports; a search that finds more ends `truncated`. */
export const FILE_SEARCH_MAX_MATCHES = 5000;
const glob = z.string().min(1).max(512);
export const FileOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), path, limit: z.number().int().min(1).max(1000).default(1000) }),
  /**
   * One folder's entries, a page at a time, for a tree that lists a folder only when it is
   * opened. `path` is the folder ("": the checkout's root) and `cursor` is the previous page's
   * `nextCursor`. A cursor for a folder that changed since it was read is `INVALID_CURSOR`: list
   * the folder again from the start. `limit` 1..=5000, 500 by default.
   */
  z.object({
    op: z.literal("list.folder"),
    path,
    limit: z.number().int().min(1).max(5000).default(500),
    cursor: z.string().max(512).optional(),
  }),
  /**
   * Search the checkout's file contents. Matches stream as `files.search.matches` messages
   * carrying this request's id as `searchId`, then the request ends with a `files.result` whose
   * value is a `FileSearchSummary`, or a `files.error` (`FILES_RESTARTING` is worth a retry,
   * `CANCELLED` follows a `files.abort` or a newer search of the same checkout on the same
   * connection). `case` "smart" is sensitive only when the pattern has a capital letter;
   * `include` and `exclude` are gitignore-style globs; ignored files are skipped unless
   * `includeIgnored`. Files over `maxFileBytes` are skipped.
   */
  z.object({
    op: z.literal("search"),
    pattern: z.string().min(1).max(1000),
    regex: z.boolean().default(false),
    case: z.enum(["sensitive", "insensitive", "smart"]).default("smart"),
    wholeWord: z.boolean().default(false),
    include: z.array(glob).max(64).default([]),
    exclude: z.array(glob).max(64).default([]),
    includeIgnored: z.boolean().default(false),
    maxMatches: z.number().int().min(1).max(FILE_SEARCH_MAX_MATCHES).default(2000),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  }),
  z.object({ op: z.literal("stat"), path }),
  /**
   * A file's details and up to `length` of its bytes from `offset`, in one reply, so a viewer
   * shows a small file after one round trip. A bigger file is read as several parts at once,
   * each sent with the first part's version as `validator`. No bytes come back when the file
   * is larger than `maxSize`. With "gzip" in `encodings` the daemon may compress the bytes.
   */
  z.object({
    op: z.literal("read"),
    path,
    offset: offset.default(0),
    length: z.number().int().min(1).max(FILE_READ_PART).default(FILE_READ_PART),
    validator: FileVersion.optional(),
    maxSize: offset.optional(),
    encodings: z.array(z.literal("gzip")).max(4).default([]),
  }),
  z.object({
    op: z.literal("download"),
    path,
    offset: offset.default(0),
    validator: FileVersion.optional(),
  }),
  /**
   * Read-only download of a local file that an assistant message in the request's thread links
   * to. The daemon resolves `reference` (the link target exactly as the message wrote it) only
   * after finding that link in `itemId`; it never reads a path the client chose on its own.
   */
  z.object({
    op: z.literal("link.download"),
    itemId: ItemId,
    reference: path,
    offset: offset.default(0),
    validator: FileVersion.optional(),
  }),
  z.object({
    op: z.literal("artifact.download"),
    artifactId: id,
    offset: offset.default(0),
    validator: FileVersion.optional(),
  }),
  z.object({ op: z.literal("archive.preview"), path, includeIgnored: z.boolean().default(false) }),
  z.object({ op: z.literal("archive.download"), previewId: id }),
  z.object({ op: z.literal("upload.begin"), path, expected, size: offset }),
  z.object({ op: z.literal("upload.resume"), uploadId: id }),
  z.object({
    op: z.literal("upload.commit"),
    uploadId: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ op: z.literal("upload.cancel"), uploadId: id }),
  z.object({ op: z.literal("write"), path, expected, text: z.string().max(1024 * 1024) }),
  z.object({
    op: z.literal("create"),
    path,
    expected: z.null(),
    text: z
      .string()
      .max(1024 * 1024)
      .default(""),
  }),
  z.object({ op: z.literal("mkdir"), path, expected: z.null() }),
  z.object({
    op: z.literal("rename"),
    path,
    expected,
    destination: path,
    destinationExpected: expected,
  }),
  z.object({
    op: z.literal("move"),
    path,
    expected,
    destination: path,
    destinationExpected: expected,
  }),
  z.object({ op: z.literal("delete"), path, expected }),
  z.object({ op: z.literal("restore"), trashId: id, path, expected }),
  z.object({ op: z.literal("artifacts.list") }),
  z.object({ op: z.literal("artifact.support"), includeThreads: z.boolean().optional() }),
  z.object({ op: z.literal("artifact.output"), streamId: id }),
  z.object({ op: z.literal("artifact.raw"), blobRef: id }),
  z.object({
    op: z.literal("trash.list"),
    after: id.optional(),
    limit: z.number().int().min(1).max(64).default(32),
  }),
  /**
   * Read-only download of media the daemon fetched for forge text (ADR 0096), by the hash a
   * `forge.media.resolve` returned. Sent with `workspaceId`.
   */
  z.object({
    op: z.literal("forge.media.download"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    offset: offset.default(0),
  }),
  z.object({
    op: z.literal("attachment.download"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    maxBytes: offset.positive().max(32 * 1024 * 1024),
  }),
]);
export type FileOperation = z.infer<typeof FileOperation>;
/**
 * The `files.result` value of a `read`. `version` is null when nothing is at the path; a folder
 * has `type` "directory" and no bytes. `data` is base64 of the part's bytes, gzip-compressed when
 * `encoding` says so; it is absent when the file is larger than the request's `maxSize`.
 */
export const FileReadResult = z.object({
  path,
  version: FileVersion.nullable(),
  type: z.enum(["file", "directory", "symlink", "other"]).optional(),
  size: offset.optional(),
  offset: offset.optional(),
  encoding: z.enum(["identity", "gzip"]).optional(),
  data: z
    .string()
    .max(Math.ceil(FILE_READ_PART / 3) * 4)
    .optional(),
});
export type FileReadResult = z.infer<typeof FileReadResult>;
/**
 * One entry of a folder listing. `kind` is what the entry is on disk; a `symlink` also names the
 * kind it points to in `target`, left out when the link leaves the checkout. `ignored` marks an
 * entry that the checkout's gitignore rules exclude; clients show it dimmed rather than hide it.
 */
export const FolderEntry = z.object({
  name: z.string().min(1).max(1024),
  /** Relative to the checkout's root, `/` separated, never ending in `/`. */
  path,
  kind: z.enum(["file", "directory", "symlink", "other"]),
  target: z.enum(["file", "directory", "other"]).optional(),
  size: offset,
  mtimeMs: z.number().int(),
  ignored: z.boolean(),
});
export type FolderEntry = z.infer<typeof FolderEntry>;
/**
 * One page of a folder. `nextCursor` is null on the folder's last page, and its value is the
 * next request's `cursor`. `total` counts every entry in the folder.
 */
export const FolderPage = z.object({
  entries: z.array(FolderEntry).max(5000),
  nextCursor: z.string().max(512).nullable(),
  total: offset,
});
export type FolderPage = z.infer<typeof FolderPage>;
/**
 * One matching line of a content search. `line` is 1-based. `preview` is at most 400 bytes of
 * the line around its first match; `column` counts the line's UTF-16 code units before the
 * preview (0 unless a long line was cut). `ranges` are UTF-16 `[start, end)` offsets inside
 * `preview`, so a match starts in the line at `column + start`.
 */
export const FileSearchLine = z.object({
  line: z.number().int().positive(),
  column: offset,
  preview: z.string().max(1024),
  ranges: z.array(z.tuple([offset, offset])).max(256),
});
export type FileSearchLine = z.infer<typeof FileSearchLine>;
/** Matching lines of one file; a file with many matches may arrive over several messages. */
export const FileSearchFile = z.object({
  path,
  lines: z.array(FileSearchLine).min(1).max(FILE_SEARCH_MAX_MATCHES),
});
export type FileSearchFile = z.infer<typeof FileSearchFile>;
/**
 * The `files.result` value that ends a content search: files with a match, matches counted, and
 * whether the search stopped at `maxMatches` with more left unreported.
 */
export const FileSearchSummary = z.object({
  files: offset,
  matches: offset,
  truncated: z.boolean(),
});
export type FileSearchSummary = z.infer<typeof FileSearchSummary>;
export const FilesClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("files.abort"), sourceRequestId: id }),
  z.object({
    type: z.literal("files.pull"),
    requestId: id,
    channel: z.number().int().positive().max(0xffffffff),
  }),
  z.object({
    type: z.literal("files.chunk"),
    requestId: id,
    channel: z.number().int().positive().max(0xffffffff),
    offset,
    data: z
      .string()
      .min(4)
      .max(87384)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.object({
    type: z.literal("files.request"),
    requestId: id,
    threadId: ThreadId.optional(),
    /**
     * A registered project's own folder instead of a thread's checkout, before any thread
     * exists: read-only, and only `list`, `stat`, `read` and `download`. Never sent with `threadId`.
     */
    workspaceId: WorkspaceId.optional(),
    scope: z.literal("support").optional(),
    operation: FileOperation,
  }),
  /**
   * The folders a client's tree has open in a thread. Each call replaces that client's set for
   * the thread, and `[]` stops watching it. The daemon answers with `files.folders_changed`,
   * naming only folders in this set, so the client re-lists just those. At most 512 folders.
   */
  z.object({
    type: z.literal("files.watch"),
    threadId: ThreadId,
    folders: z.array(path).max(512),
  }),
  z.object({
    type: z.literal("files.credit"),
    channel: z.number().int().min(1).max(0xffffffff),
    credits: z.number().int().min(1).max(8),
  }),
  z.object({ type: z.literal("files.cancel"), channel: z.number().int().min(1).max(0xffffffff) }),
]);
export type FilesClientMessage = z.infer<typeof FilesClientMessage>;
export const WorkspaceFileChange = z.object({
  id,
  op: z.string(),
  path,
  destination: path.optional(),
  version: FileVersion.nullable(),
  trashId: id.optional(),
});
export type WorkspaceFileChange = z.infer<typeof WorkspaceFileChange>;
export const FilesServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("files.data"),
    requestId: id,
    channel: z.number().int().positive(),
    offset,
    data: z.string().max(87384),
    eof: z.boolean(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.object({ type: z.literal("files.cancelled"), channel: z.number() }),
  z.object({ type: z.literal("files.result"), requestId: id, value: z.unknown() }),
  z.object({
    type: z.literal("files.error"),
    requestId: id.optional(),
    channel: z.number().optional(),
    code: z.string(),
    message: z.string(),
    current: FileVersion.nullable().optional(),
    /** Where an entry that could not be put back is preserved, for the client to show. */
    recovery: path.optional(),
  }),
  z.object({
    type: z.literal("files.ready"),
    requestId: id,
    channel: z.number(),
    offset,
    size: offset.nullable(),
    validator: FileVersion,
    mimeType: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal("files.end"),
    channel: z.number(),
    offset,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type: z.literal("files.upload"),
    requestId: id.optional(),
    channel: z.number(),
    uploadId: id,
    offset,
    size: offset,
  }),
  z.object({ type: z.literal("files.changed"), change: WorkspaceFileChange }),
  /**
   * A batch of content search matches for the `files.request` whose id is `searchId`: sent at
   * most every 50 ms or 200 lines, in the order ace-files found them.
   */
  z.object({
    type: z.literal("files.search.matches"),
    searchId: id,
    files: z.array(FileSearchFile).min(1).max(FILE_SEARCH_MAX_MATCHES),
  }),
  /**
   * Folders of a watched thread that changed, coalesced to at most one message per 100 ms per
   * client. `rescan` says the watcher fell behind and every watched folder should be listed
   * again; otherwise `folders` names the watched folders a change was found in.
   */
  z.object({
    type: z.literal("files.folders_changed"),
    threadId: ThreadId,
    folders: z.array(path).max(512),
    rescan: z.boolean(),
  }),
]);
export type FilesServerMessage = z.infer<typeof FilesServerMessage>;

export const WorkspaceFilesChanged = z.object({
  type: z.literal("workspace.files_changed"),
  workspaceId: WorkspaceId,
  change: WorkspaceFileChange,
});
export type WorkspaceFilesChanged = z.infer<typeof WorkspaceFilesChanged>;
