import { z } from "zod";
import { WorkspaceId } from "./ids.ts";

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z.string().max(4096);
const id = z.string().min(1).max(128);
export const FileVersion = z.string().min(1).max(256);
const expected = FileVersion.nullable();
export const FileOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stat"), path }),
  z.object({
    op: z.literal("download"),
    path,
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
  z.object({ op: z.literal("artifact.support") }),
  z.object({ op: z.literal("artifact.output"), streamId: id }),
  z.object({ op: z.literal("artifact.raw"), blobRef: id }),
  z.object({
    op: z.literal("trash.list"),
    after: id.optional(),
    limit: z.number().int().min(1).max(64).default(32),
  }),
]);
export type FileOperation = z.infer<typeof FileOperation>;
export const FilesClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("files.request"), requestId: id, operation: FileOperation }),
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
