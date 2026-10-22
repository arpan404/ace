import { z } from "zod";
import { ItemId, ThreadId, WorkspaceId } from "./ids.ts";

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z.string().max(4096);
const id = z.string().min(1).max(128);
export const FileVersion = z.string().min(1).max(256);
const expected = FileVersion.nullable();
/** The most one `read` returns: big enough for most source files, small enough to share a link. */
export const FILE_READ_PART = 256 * 1024;
export const FileOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), path, limit: z.number().int().min(1).max(1000).default(1000) }),
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
]);
export type FilesServerMessage = z.infer<typeof FilesServerMessage>;

export const WorkspaceFilesChanged = z.object({
  type: z.literal("workspace.files_changed"),
  workspaceId: WorkspaceId,
  change: WorkspaceFileChange,
});
export type WorkspaceFilesChanged = z.infer<typeof WorkspaceFilesChanged>;
