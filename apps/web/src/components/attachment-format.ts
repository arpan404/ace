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

/** A file being added to the next message, as the composer's chip shows it. */
export interface ChipAttachment {
  key: number;
  name: string;
  /** Object URL for image previews; a draft restored after a reload has none. */
  preview?: string | undefined;
  /** The file itself, for its preview; a draft restored after a reload has none. */
  file?: File | undefined;
  mimeType?: string | undefined;
  /** The daemon's reading of the bytes, once it holds them. */
  kind?: Attachment["kind"] | undefined;
  bytes?: number | undefined;
  /** Set once the daemon holds the file. */
  sha256?: string | undefined;
  state: "uploading" | "ready" | "failed";
  /** 0..1 */
  progress: number;
  /** Why it failed, in words. */
  error?: string | undefined;
  /** Whether trying again can help (a file over the limit can't). */
  retryable?: boolean | undefined;
}

/** Where an image's bytes come from. Attachments resolve through the owning connection. */
export type ImageSource =
  | { kind: "attachment"; threadId: string; sha256: string; bytes: number; thumbnail: boolean }
  | { kind: "url"; url: string };

/** Where a file's bytes come from: the browser's own file before it is sent, else the daemon. */
export type FileSource =
  | { kind: "file"; file: File }
  | { kind: "artifact"; threadId: string; artifactId: string; bytes: number }
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

/** One cell of a message's image group, sized before its bytes arrive. */
export interface ImageCell {
  image: ShownImage;
  /** Its position among all the message's images, for the lightbox. */
  index: number;
  width: number;
  height: number;
  /** The tall left cell of a group of three spans both rows. */
  tall?: boolean;
  /** On the last cell of a group of five or more: how many images it stands for ("+N"). */
  more?: number;
}

export interface ImageLayout {
  kind: "single" | "pair" | "trio" | "grid";
  cells: ImageCell[];
}

/** Square cells of a group, and the gap between them. */
const cell = 160;
const cellGap = 4;

/**
 * How a message's images are laid out: one keeps its aspect within 320×320; two are side-by-side
 * squares; three are a tall cell on the left and two stacked squares; four or more are a 2×2
 * grid whose fourth cell, past four, stands for the rest as "+N".
 */
export function imageLayout(images: readonly ShownImage[]): ImageLayout {
  const [first] = images;
  if (!first) return { kind: "grid", cells: [] };
  if (images.length === 1)
    return { kind: "single", cells: [{ image: first, index: 0, ...singleImageSize(first) }] };
  const square = (image: ShownImage, index: number): ImageCell => ({
    image,
    index,
    width: cell,
    height: cell,
  });
  if (images.length === 2) return { kind: "pair", cells: images.map(square) };
  if (images.length === 3)
    return {
      kind: "trio",
      cells: images.map((image, index) =>
        index === 0
          ? { image, index, width: cell, height: cell * 2 + cellGap, tall: true }
          : square(image, index),
      ),
    };
  const cells = images.slice(0, 4).map(square);
  const last = cells[3];
  if (last && images.length > 4) last.more = images.length - 3;
  return { kind: "grid", cells };
}

/** The height an image group takes before its cells are known, from the images' shapes. */
export function imageGroupHeight(images: readonly Pick<ShownImage, "width" | "height">[]): number {
  const [first] = images;
  if (!first) return 0;
  if (images.length === 1) return singleImageSize(first).height;
  return images.length === 2 ? cell : cell * 2 + cellGap;
}

/** A message's lone image keeps its aspect within 320×320 (4:3 when unknown). */
function singleImageSize(image: Pick<ShownImage, "width" | "height">): {
  width: number;
  height: number;
} {
  return fitWithin(image, 320, 320);
}

/** An inline image in prose keeps its aspect within 320×240 (4:3 when unknown). */
export function tileSize(image: Pick<ShownImage, "width" | "height">): {
  width: number;
  height: number;
} {
  return fitWithin(image, 320, 240);
}

function fitWithin(
  image: Pick<ShownImage, "width" | "height">,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const width = image.width ?? 4,
    height = image.height ?? 3;
  const scale = Math.min(maxWidth / width, maxHeight / height, image.width ? 1 : Infinity);
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
