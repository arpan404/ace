import { maxSpadeRequestBytes } from "@ace/protocol";
import type { SpadeImageRef } from "@ace/ui-core/spade-chat";

/** Spade's own limits on a message's images. */
export const maxSpadeImages = 8;
const spadeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageBytes = 5 * 1024 * 1024;
/**
 * Room for images in one `spade.http` body (512 KiB with the text and JSON around it). The
 * daemon carries text bodies only, so images go as base64 and are made smaller until they fit.
 */
const imageBudget = maxSpadeRequestBytes - 16 * 1024;
/** Longest sides tried, largest first, when the images must shrink to fit. */
const sides = [2048, 1600, 1280, 1024, 768, 512, 384];

export interface PreparedImage {
  /** Base64, as Spade takes it. */
  data: string;
  ref: SpadeImageRef;
}

export class SpadeImageError extends Error {}

/** What Spade is sent: the words and the attached images, either of which may be empty. */
export interface SpadeMessage {
  text: string;
  images: PreparedImage[];
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A JPEG of `file` whose longest side is at most `side` (never larger than it was). */
async function shrink(file: Blob, side: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  const context = canvas.getContext("2d");
  if (!context) throw new SpadeImageError("This browser can't resize images.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
}

const encodedSize = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * The message's files as Spade images: PNG, JPEG, GIF or WebP, at most eight. As sent they must
 * fit one request together, so if they don't, each one over its share is re-encoded smaller
 * (largest sides first) until they do. Throws `SpadeImageError` with words for the person when that can't work.
 */
export async function prepareSpadeImages(files: readonly File[]): Promise<PreparedImage[]> {
  if (files.length > maxSpadeImages)
    throw new SpadeImageError(`Spade takes at most ${maxSpadeImages} images in a message.`);
  for (const file of files)
    if (!spadeTypes.has(file.type))
      throw new SpadeImageError("Spade takes PNG, JPEG, GIF and WebP images, not other files.");
  let blobs: Blob[] = [...files];
  const total = () => blobs.reduce((sum, blob) => sum + encodedSize(blob.size), 0);
  for (const side of sides) {
    if (total() <= imageBudget && blobs.every((blob) => blob.size <= maxImageBytes)) break;
    // Only an image over its share shrinks; a small one goes as it was.
    const share = imageBudget / files.length;
    blobs = await Promise.all(
      files.map((file) =>
        encodedSize(file.size) > share || file.size > maxImageBytes ? shrink(file, side) : file,
      ),
    );
  }
  if (total() > imageBudget)
    throw new SpadeImageError("These images are too large to send together. Send fewer at once.");
  return Promise.all(
    blobs.map(async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ref = { sha256: await sha256(bytes), mediaType: blob.type, bytes: bytes.length };
      rememberImage(ref.sha256, blob);
      return { data: base64(bytes), ref };
    }),
  );
}

/*
 * Images sent from this window, by hash, for the person's messages. Spade's copies can't come
 * back through the daemon yet (it carries text bodies only), so an image sent elsewhere shows as
 * a placeholder. Object URLs live as long as the page.
 */
const sent = new Map<string, string>();

function rememberImage(hash: string, blob: Blob) {
  if (!sent.has(hash)) sent.set(hash, URL.createObjectURL(blob));
}

/** A picture for an image this window sent, if it did. */
export function sentImageUrl(hash: string): string | undefined {
  return sent.get(hash);
}
