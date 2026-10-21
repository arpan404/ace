import { z } from "zod";
import { ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
/** The most UTF-16 units of text one page carries. */
export const forgeFileTextPage = 262_144;
/** The largest file read whole, on either side of a diff (2.5 MiB). */
export const forgeFileMaxBytes = 2_621_440;
const size = z.number().int().nonnegative();

/** Image types the page can draw from bytes. SVG is text and diffs as text. */
export const ForgeImageType = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
]);
export type ForgeImageType = z.infer<typeof ForgeImageType>;

/**
 * One side of a changed file at a commit, read on demand where GitHub withheld the patch:
 * text in pages, an image as base64 bytes, or why there is nothing to read.
 */
export const ForgeFileContent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().max(forgeFileTextPage),
    /** The whole file's size in bytes. */
    size,
    nextPage: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    type: ForgeImageType,
    /** The bytes, base64. */
    data: z.string().max(Math.ceil(forgeFileMaxBytes / 3) * 4),
    size,
  }),
  z.object({ kind: z.literal("binary"), size }),
  /** Over `forgeFileMaxBytes`: never read. */
  z.object({ kind: z.literal("large"), size }),
  /** No file at this path at this commit (added, removed, or a folder or submodule). */
  z.object({ kind: z.literal("missing") }),
]);
export type ForgeFileContent = z.infer<typeof ForgeFileContent>;

export const ForgeFileContentOperations = [
  z.object({
    op: z.literal("forge.file.content"),
    workspaceId: WorkspaceId,
    repository: ForgeRepository.optional(),
    /** A commit: content at it never changes. */
    sha,
    path: z.string().min(1).max(4_096),
    page: z.number().int().min(1).max(16).default(1),
    /** Read the bytes as this image type, rather than as text. */
    image: ForgeImageType.optional(),
  }),
] as const;

export const ForgeFileContentResults = [
  z.object({ resource: z.literal("fileContent"), value: ForgeFileContent }),
] as const;
