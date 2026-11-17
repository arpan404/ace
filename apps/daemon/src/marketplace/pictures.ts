import { sha256Hex } from "@ace/marketplace";
import type { MarketPictureKind, MarketResult } from "@ace/protocol/marketplace";
import type { MarketHttp } from "./http.ts";

/*
 * Listing pictures and avatars (ADR 0174 §3, §5) for the app's cards: fetched from the market by
 * sha256, kept only when the bytes hash to the name asked for and start like a PNG, JPEG or WebP,
 * and held in a small memory cache so a page of cards costs one fetch per picture.
 */

type Picture = Extract<MarketResult, { op: "picture" }>;

/** The picture's type by its first bytes; undefined for anything else. */
export function pictureType(bytes: Uint8Array): Picture["type"] | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return undefined;
}

const cacheBytes = 24 * 1024 * 1024;

export class MarketPictures {
  /** Oldest first; a hit moves to the end. */
  readonly #held = new Map<string, Picture>();
  #bytes = 0;

  async read(http: MarketHttp, kind: MarketPictureKind, hash: string): Promise<Picture> {
    const key = `${kind}/${hash}`;
    const held = this.#held.get(key);
    if (held) {
      this.#held.delete(key);
      this.#held.set(key, held);
      return held;
    }
    const bytes = await http.picture(kind, hash);
    if (sha256Hex(bytes) !== hash) throw new PictureRefused("The picture isn't the one named");
    const type = pictureType(bytes);
    if (!type) throw new PictureRefused("The picture isn't a PNG, JPEG or WebP");
    const picture: Picture = { op: "picture", type, data: Buffer.from(bytes).toString("base64") };
    this.#held.set(key, picture);
    this.#bytes += picture.data.length;
    for (const [old, value] of this.#held) {
      if (this.#bytes <= cacheBytes) break;
      this.#held.delete(old);
      this.#bytes -= value.data.length;
    }
    return picture;
  }
}

export class PictureRefused extends Error {
  override name = "PictureRefused";
}
