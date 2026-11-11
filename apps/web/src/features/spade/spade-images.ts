import type { ClientApi } from "@ace/client";
import type { SpadeImageRef } from "@ace/ui-core/spade-chat";
import { spadeBlob, segment } from "./spade-requests.ts";

/** Spade's own limits on a message's images. */
export const maxSpadeImages = 8;
const spadeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Spade's own cap: providers count 5 MB on the base64, which is 3.75 MB of image. */
const maxImageBytes = 3_750_000;

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
 * 3.75 MB each, Spade's own limits. Throws `SpadeImageError` with words for the person otherwise.
 */
export async function prepareSpadeImages(files: readonly File[]): Promise<PreparedImage[]> {
  if (files.length > maxSpadeImages)
    throw new SpadeImageError(`Spade takes at most ${maxSpadeImages} images in a message.`);
  for (const file of files) {
    if (!spadeTypes.has(file.type))
      throw new SpadeImageError("Spade takes PNG, JPEG, GIF and WebP images, not other files.");
    if (file.size > maxImageBytes)
      throw new SpadeImageError(`${file.name} is larger than 3.75 MB, the most Spade takes.`);
  }
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = { sha256: await sha256(bytes), mediaType: file.type, bytes: bytes.length };
      if (!pictures.has(ref.sha256))
        remember(ref.sha256, Promise.resolve(URL.createObjectURL(file)));
      return { data: base64(bytes), ref };
    }),
  );
}

/*
 * Pictures by hash: ones this window sent, and ones read from Spade (`GET /v1/images/{sha256}`,
 * immutable). Each hash is read once while shown; a failed read is forgotten so it can be tried
 * again. A picture nothing shows for a minute is let go (its object URL revoked).
 */
interface Picture {
  url: Promise<string>;
  holders: number;
  cancel: (() => void) | undefined;
}
const pictures = new Map<string, Picture>();
const idleMs = 60_000;

function letGoLater(hash: string, picture: Picture) {
  const timer = setTimeout(() => {
    if (pictures.get(hash) !== picture || picture.holders > 0) return;
    pictures.delete(hash);
    void picture.url.then(
      (url) => URL.revokeObjectURL(url),
      () => {},
    );
  }, idleMs);
  picture.cancel = () => clearTimeout(timer);
}

function remember(hash: string, url: Promise<string>): Picture {
  const picture: Picture = { url, holders: 0, cancel: undefined };
  pictures.set(hash, picture);
  url.catch(() => {
    if (pictures.get(hash) === picture) pictures.delete(hash);
  });
  letGoLater(hash, picture);
  return picture;
}

/**
 * A picture for a stored image, held until `release`: this window's own, or Spade's copy read
 * once and kept while anything shows it.
 */
export function holdSpadePicture(client: ClientApi, hash: string) {
  const picture =
    pictures.get(hash) ??
    remember(
      hash,
      spadeBlob(client, `/v1/images/${segment(hash)}`).then((blob) => URL.createObjectURL(blob)),
    );
  picture.holders++;
  picture.cancel?.();
  picture.cancel = undefined;
  let held = true;
  return {
    url: picture.url,
    release() {
      if (!held) return;
      held = false;
      picture.holders--;
      if (picture.holders === 0) letGoLater(hash, picture);
    },
  };
}
