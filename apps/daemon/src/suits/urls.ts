import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Where a Suit's scene and assets are served: `/v1/suits/<id>/<contentHash>/<grant>/<file>`.
 * An iframe or a font face can't send the device's bearer, so the URL carries its own grant: an
 * HMAC of the Suit and its content under a key this daemon run holds. Only an authenticated
 * `read` hands one out; it names one version of one Suit, never a device credential, and dies
 * with the daemon run or the next edit to the Suit.
 */

export const suitsPathPrefix = "/v1/suits/";

const grantLength = 32;

export class SuitUrls {
  readonly #key: Uint8Array;
  constructor(key: Uint8Array) {
    this.#key = key;
  }

  grant(id: string, hash: string): string {
    return createHmac("sha256", this.#key)
      .update(`${id}/${hash}`)
      .digest("hex")
      .slice(0, grantLength);
  }

  /** The folder URL of one version of a Suit, ending in `/`. */
  base(id: string, hash: string): string {
    return `${suitsPathPrefix}${id}/${hash}/${this.grant(id, hash)}/`;
  }

  /** The Suit, version and file a request path names, when its grant holds. */
  parse(path: string): { id: string; hash: string; file: string } | undefined {
    const match = /^\/v1\/suits\/([a-z0-9-]{1,48})\/([a-f0-9]{64})\/([a-f0-9]{32})\/(.+)$/.exec(
      path,
    );
    if (!match) return undefined;
    const [, id, hash, grant, encoded] = match;
    if (!id || !hash || !grant || !encoded) return undefined;
    const expected = Buffer.from(this.grant(id, hash));
    if (!timingSafeEqual(expected, Buffer.from(grant))) return undefined;
    let file: string;
    try {
      file = encoded
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
    } catch {
      return undefined;
    }
    if (file.split("/").some((part) => part === "" || part === "." || part === ".."))
      return undefined;
    return { id, hash, file };
  }
}

/** A path inside a Suit as a URL path, each segment encoded. */
export const encodeSuitPath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
