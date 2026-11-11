import type { ClientApi } from "@ace/client";
import type { SpadeImageRef } from "@ace/ui-core/spade-chat";
import { spadeBlob, segment } from "./spade-requests.ts";

/** Spade's own limits on a message's images. */
export const maxSpadeImages = 8;
const spadeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageBytes = 5 * 1024 * 1024;

export interface PreparedImage {
  /** Base64 of the file as it is, as Spade takes it. */
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

/**
 * The message's files as Spade images, sent as they are: PNG, JPEG, GIF or WebP, at most eight,
 * 5 MB each, Spade's own limits. Throws `SpadeImageError` with words for the person otherwise.
 */
export async function prepareSpadeImages(files: readonly File[]): Promise<PreparedImage[]> {
  if (files.length > maxSpadeImages)
    throw new SpadeImageError(`Spade takes at most ${maxSpadeImages} images in a message.`);
  for (const file of files) {
    if (!spadeTypes.has(file.type))
      throw new SpadeImageError("Spade takes PNG, JPEG, GIF and WebP images, not other files.");
    if (file.size > maxImageBytes)
      throw new SpadeImageError(`${file.name} is larger than 5 MB, the most Spade takes.`);
  }
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = { sha256: await sha256(bytes), mediaType: file.type, bytes: bytes.length };
      pictures.set(ref.sha256, Promise.resolve(URL.createObjectURL(file)));
      return { data: base64(bytes), ref };
    }),
  );
}

/*
 * Pictures by hash: ones this window sent, and ones read from Spade (`GET /v1/images/{sha256}`,
 * immutable). Each hash is read once per page; a failed read is forgotten so it can be tried
 * again. Object URLs live as long as the page.
 */
const pictures = new Map<string, Promise<string>>();

/** A picture for a stored image: this window's own, or Spade's copy read once and kept. */
export function spadePicture(client: ClientApi, hash: string): Promise<string> {
  let picture = pictures.get(hash);
  if (!picture) {
    picture = spadeBlob(client, `/v1/images/${segment(hash)}`).then((blob) =>
      URL.createObjectURL(blob),
    );
    picture.catch(() => pictures.delete(hash));
    pictures.set(hash, picture);
  }
  return picture;
}
