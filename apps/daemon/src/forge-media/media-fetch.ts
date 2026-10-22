import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { publicResponse, type PublicFetchOptions } from "../icons/public-fetch.ts";
import { sniffBytes, sniffMedia, type SniffedMedia } from "./media-sniff.ts";

/*
 * One media file from the forge's media hosts into a temporary file (ADR 0096). Only a URL on a
 * host the forge serves media from is fetched (GitHub's attachment, camo and user-content hosts;
 * an Enterprise host's own media), through the public-web fetch: no cookies, credentials or
 * referrer, every hop's address checked. Bytes stream to disk under a size cap while they are
 * hashed, and the result is media only if its leading bytes say so.
 */

export type FetchedMedia =
  | { kind: "ok"; sha256: string; bytes: number; media: SniffedMedia }
  | { kind: "missing"; status?: number | undefined }
  | { kind: "too_large" }
  | { kind: "unsupported" }
  | { kind: "refused" }
  | { kind: "failed" };

const githubMedia = new Set([
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "avatars.githubusercontent.com",
  "github.githubassets.com",
]);

/** Whether the daemon may fetch `url` as media rendered by the forge at `forgeHost`. */
export function mediaHostAllowed(url: string, forgeHost: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (forgeHost === "github.com") return githubMedia.has(parsed.hostname);
  return parsed.hostname === forgeHost || parsed.hostname.endsWith(`.${forgeHost}`);
}

export interface MediaFetchOptions extends Pick<PublicFetchOptions, "resolve" | "allowed"> {
  maxBytes: number;
  timeoutMs?: number;
}

/** Fetch `url` into `temporary`; the file is left only when the result is `ok`. */
export async function fetchMedia(
  url: string,
  temporary: string,
  options: MediaFetchOptions,
): Promise<FetchedMedia> {
  const opened = await publicResponse(url, {
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.allowed ? { allowed: options.allowed } : {}),
    // Per hop; a large video on a slow link gets four times this in all.
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRedirects: 3,
    accept: "image/*,video/*",
  });
  if (opened.kind !== "ok") return opened;
  const { response } = opened;
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    response.destroy();
    return { kind: "too_large" };
  }
  const hash = createHash("sha256");
  const file = createWriteStream(temporary, { mode: 0o600 });
  const head: Buffer[] = [];
  let headBytes = 0;
  let total = 0;
  let over = false;
  try {
    for await (const chunk of response) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += part.length;
      if (total > options.maxBytes) {
        over = true;
        response.destroy();
        break;
      }
      if (headBytes < sniffBytes) {
        head.push(part.subarray(0, sniffBytes - headBytes));
        headBytes += Math.min(part.length, sniffBytes - headBytes);
      }
      hash.update(part);
      if (!file.write(part)) await new Promise((resolve) => file.once("drain", resolve));
    }
    file.end();
    await finished(file);
  } catch {
    file.destroy();
    await unlink(temporary).catch(() => {});
    return { kind: "failed" };
  }
  const media = sniffMedia(Buffer.concat(head));
  if (over || !total || !media) {
    await unlink(temporary).catch(() => {});
    return over ? { kind: "too_large" } : !total ? { kind: "missing" } : { kind: "unsupported" };
  }
  return { kind: "ok", sha256: hash.digest("hex"), bytes: total, media };
}
