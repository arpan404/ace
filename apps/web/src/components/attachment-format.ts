import type { Attachment, ContentPart } from "@ace/protocol";
import { formatBytes } from "./format-bytes.ts";

/*
 * What a message's attachments look like on screen, decided without I/O: which are images and
 * which are file chips, the words on them, and the size of each thumbnail before its bytes
 * arrive, so the transcript never shifts while they load. Host paths are never shown.
 */

/** A file of a message the daemon doesn't hold yet (a pending send), from this device. */
export interface LocalAttachment {
  name: string;
  mimeType: string;
  /** Size in bytes. */
  bytes: number;
  /** A `blob:` preview for images. */
  previewUrl?: string | undefined;
}

/** Where an image's bytes come from. Attachments resolve through the owning connection. */
export type ImageSource =
  | { kind: "attachment"; threadId: string; sha256: string; bytes: number; thumbnail: boolean }
  | { kind: "url"; url: string };

/** Where a file's bytes come from: the browser's own file before it is sent, else the daemon. */
export type FileSource =
  | { kind: "file"; file: File }
  | { kind: "attachment"; threadId: string; sha256: string; bytes: number };

/** A file the preview can show: what it is, and where its bytes are when this device has them. */
export interface PreviewFile {
  name: string;
  bytes?: number | undefined;
  mimeType?: string | undefined;
  kind?: Attachment["kind"] | undefined;
  delivery?: Attachment["delivery"] | undefined;
  source?: FileSource | undefined;
}

export interface ShownImage {
  delivery?: Attachment["delivery"];
  key: string;
  name: string;
  bytes?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  source: ImageSource;
}
export interface ShownFile {
  delivery?: Attachment["delivery"];
  key: string;
  name: string;
  mimeType?: string | undefined;
  /** The daemon's reading of the bytes (`image`, `pdf`, `text`, `binary`). */
  kind?: Attachment["kind"];
  bytes?: number | undefined;
  /** Where this device can read the file for its preview; a path an agent named has none. */
  source?: Extract<FileSource, { kind: "attachment" }> | undefined;
}
export interface Shown {
  images: ShownImage[];
  files: ShownFile[];
}

/** Bytes as people say them: 940 B, 12 KB, 3.4 MB. */
export { formatBytes };

/** The last segment of a path or URL; a stored blob named by its hash reads as "Attached file". */
export function displayName(path: string, fallback = "Attached file"): string {
  const name = path.split(/[\\/]/).findLast((segment) => segment !== "") ?? "";
  return !name || /^[a-f0-9]{64}(\.\w+)?$/.test(name) ? fallback : name;
}

/** Image URLs a message may load as-is: inline data, this page's blobs and the web. */
export function loadableImageUrl(url: string): boolean {
  return /^(data:image\/|blob:|https?:)/i.test(url);
}

/** Split a message's attachments, content parts and local files into thumbnails and chips. */
export function collectAttachments(input: {
  threadId?: string | undefined;
  attachments?: readonly Attachment[] | undefined;
  parts?: readonly ContentPart[] | undefined;
  local?: readonly LocalAttachment[] | undefined;
}): Shown {
  const shown: Shown = { images: [], files: [] };
  for (const [index, file] of (input.local ?? []).entries()) {
    const key = `local:${index}`;
    if (file.previewUrl && file.mimeType.startsWith("image/"))
      shown.images.push({
        key,
        name: file.name,
        bytes: file.bytes,
        source: { kind: "url", url: file.previewUrl },
      });
    else shown.files.push({ key, name: file.name, mimeType: file.mimeType, bytes: file.bytes });
  }
  for (const attachment of input.attachments ?? []) {
    const key = `sha:${attachment.sha256}`;
    if (attachment.thumbnailAvailable && input.threadId)
      shown.images.push({
        key,
        delivery: attachment.delivery,
        name: attachment.name,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        source: {
          kind: "attachment",
          threadId: input.threadId,
          sha256: attachment.sha256,
          bytes: attachment.bytes,
          thumbnail: attachment.thumbnailAvailable === true,
        },
      });
    else
      shown.files.push({
        key,
        delivery: attachment.delivery,
        name: attachment.name,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        bytes: attachment.bytes,
        source: input.threadId
          ? {
              kind: "attachment",
              threadId: input.threadId,
              sha256: attachment.sha256,
              bytes: attachment.bytes,
            }
          : undefined,
      });
  }
  for (const [index, part] of (input.parts ?? []).entries()) {
    const key = `part:${index}`;
    if (part.type === "image" && loadableImageUrl(part.url))
      shown.images.push({
        key,
        name: part.url.startsWith("data:") ? "Attached image" : displayName(part.url, "Image"),
        source: { kind: "url", url: part.url },
      });
    else if (part.type === "file")
      shown.files.push({
        key,
        name: displayName(
          part.path,
          part.mimeType?.startsWith("image/") ? "Attached image" : "Attached file",
        ),
        mimeType: part.mimeType,
      });
  }
  return shown;
}

/** Thumbnails shown: up to four, or three and a "+N" tile. */
export function visibleImages(count: number): { shown: number; more: number } {
  return count > 4 ? { shown: 3, more: count - 3 } : { shown: count, more: 0 };
}

/** A lone image keeps its aspect within 320×240 (4:3 when unknown); a grid's tiles are 160×120. */
export function tileSize(
  image: Pick<ShownImage, "width" | "height">,
  count: number,
): { width: number; height: number } {
  if (count > 1) return { width: 160, height: 120 };
  const width = image.width ?? 4,
    height = image.height ?? 3;
  const scale = Math.min(320 / width, 240 / height, image.width ? 1 : Infinity);
  return {
    width: Math.max(48, Math.round(width * scale)),
    height: Math.max(36, Math.round(height * scale)),
  };
}

/**
 * A saved file's name as the project knows it: relative to the first root that holds it (the
 * checkout, then the project), else just its name. Never the absolute path.
 */
export function projectRelative(path: string, roots: readonly (string | undefined)[]): string {
  const normal = path.replaceAll("\\", "/");
  for (const root of roots) {
    if (!root) continue;
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (base && normal.startsWith(`${base}/`)) return normal.slice(base.length + 1);
  }
  return normal.startsWith("/") || /^[a-z]:\//i.test(normal) ? displayName(normal, "file") : normal;
}
