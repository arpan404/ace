import type { ClientApi } from "@ace/client";
import { spadeBlob, segment } from "./spade-requests.ts";

/*
 * Media by hash: ones this window sent, and ones read from Spade (`GET /v1/images/{sha256}`,
 * `GET /v1/audio/{sha256}`, immutable). Each is read once while shown; a failed read is
 * forgotten so it can be tried again. One nothing shows for a minute is let go (its object URL
 * revoked).
 */
interface Held {
  url: Promise<string>;
  holders: number;
  cancel: (() => void) | undefined;
}
const held = new Map<string, Held>();
const idleMs = 60_000;

function letGoLater(key: string, media: Held) {
  const timer = setTimeout(() => {
    if (held.get(key) !== media || media.holders > 0) return;
    held.delete(key);
    void media.url.then(
      (url) => URL.revokeObjectURL(url),
      () => {},
    );
  }, idleMs);
  media.cancel = () => clearTimeout(timer);
}

function remember(key: string, url: Promise<string>): Held {
  const media: Held = { url, holders: 0, cancel: undefined };
  held.set(key, media);
  url.catch(() => {
    if (held.get(key) === media) held.delete(key);
  });
  letGoLater(key, media);
  return media;
}

const audioKey = (hash: string) => `audio:${hash}`;

/** This window's own copy of what it sends, so its bubble shows it before Spade's is read. */
export function keepSentPicture(hash: string, blob: Blob) {
  if (!held.has(hash)) remember(hash, Promise.resolve(URL.createObjectURL(blob)));
}

export function keepSentRecording(hash: string, blob: Blob) {
  if (!held.has(audioKey(hash)))
    remember(audioKey(hash), Promise.resolve(URL.createObjectURL(blob)));
}

function hold(client: ClientApi, key: string, path: string) {
  const media =
    held.get(key) ??
    remember(
      key,
      spadeBlob(client, path).then((blob) => URL.createObjectURL(blob)),
    );
  media.holders++;
  media.cancel?.();
  media.cancel = undefined;
  let holding = true;
  return {
    url: media.url,
    release() {
      if (!holding) return;
      holding = false;
      media.holders--;
      if (media.holders === 0) letGoLater(key, media);
    },
  };
}

/**
 * A picture for a stored image, held until `release`: this window's own, or Spade's copy read
 * once and kept while anything shows it.
 */
export function holdSpadePicture(client: ClientApi, hash: string) {
  return hold(client, hash, `/v1/images/${segment(hash)}`);
}

/** A voice message's recording, held as `holdSpadePicture` holds a picture. */
export function holdSpadeRecording(client: ClientApi, hash: string) {
  return hold(client, audioKey(hash), `/v1/audio/${segment(hash)}`);
}
