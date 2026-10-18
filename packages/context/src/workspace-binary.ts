import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ContextError } from "./errors.ts";
import { binaryMime } from "./file-kind.ts";
import type { WorkspaceFiles } from "./git-workspace.ts";
import { validateImageContainer } from "./image-container.ts";
import { inspectImage, sniffMime } from "./media.ts";
import type { PreparedAttachment, ProjectionCapabilities } from "./projection.ts";

const headerBytes = 64 * 1024;

/**
 * A non-text workspace mention is prepared like an attached file: images and PDFs carry their
 * real MIME (validated the same way as uploads) so each provider receives its native form.
 * Bytes are read only when they fit `budget`, which callers share across one message.
 */
export async function prepareWorkspaceBinary(
  workspace: WorkspaceFiles,
  path: string,
  capabilities: ProjectionCapabilities,
  budget: { remaining: number },
): Promise<PreparedAttachment> {
  const absolute = join(workspace.root, path);
  const bytes = (await lstat(absolute)).size;
  const base = { path: absolute, name: path, bytes };
  const header = (await workspace.read(path, headerBytes)).bytes;
  const sniffed = sniffMime(header);
  const image = sniffed.startsWith("image/") && capabilities.images.includes(sniffed);
  const pdf = sniffed === "application/pdf";
  const mimeType = image || pdf || sniffed.startsWith("image/") ? sniffed : binaryMime(path);
  // Codex and OpenCode read files by path; inline providers need the bytes.
  const inline = capabilities.provider !== "codex" && capabilities.provider !== "opencode";
  const document =
    pdf && (capabilities.documents.includes(mimeType) || capabilities.documents.includes("*"));
  if (!(image || document) || bytes > budget.remaining || bytes > capabilities.maxInlineBytes)
    return { ...base, mimeType, nativeImage: false };
  if (!image && !inline) return { ...base, mimeType };
  const read = await workspace.read(path, bytes);
  if (read.more || read.bytes.length !== bytes) return { ...base, mimeType, nativeImage: false };
  budget.remaining -= bytes;
  if (image)
    try {
      const checked = inspectImage(
        read.bytes.subarray(0, headerBytes),
        read.bytes.subarray(-12),
        bytes,
      );
      await validateImageContainer(absolute, checked.mimeType, bytes, checked);
    } catch (error) {
      if (!(error instanceof ContextError)) throw error;
      // Unsafe or malformed rasters stay usable by path, exactly like uploaded ones.
      return { ...base, mimeType, nativeImage: false };
    }
  return {
    ...base,
    mimeType,
    nativeImage: image,
    ...(inline ? { base64: read.bytes.toString("base64") } : {}),
  };
}
