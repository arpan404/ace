import { z } from "zod";
import {
  forgeFileMaxBytes,
  forgeFileTextPage,
  type ForgeFileContent,
  type ForgeImageType,
} from "@ace/protocol/forge-file-content";
import { ForgeError } from "./errors.ts";
import type { GhApi } from "./http.ts";
import { redact } from "./redact.ts";

const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const Entry = z.looseObject({
  type: z.string().max(32),
  size: z.number().int().nonnegative(),
  sha,
  encoding: z.string().max(32).optional(),
  content: z.string().optional(),
  target: z.string().max(4_096).optional(),
});
const Blob = z.looseObject({
  sha,
  size: z.number().int().nonnegative(),
  encoding: z.literal("base64"),
  content: z.string(),
});

/** A side read whole: what the pages of a text are cut from. */
type Whole =
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; type: ForgeImageType; data: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "large"; size: number }
  | { kind: "missing" };

const imageTypes: Record<string, ForgeImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
/** Decoded sides kept, by commit and path: content at a commit never changes. */
const cacheBytes = 33_554_432;
const strict = new TextDecoder("utf-8", { fatal: true });

/** The image type a path's extension names, if the page can draw it. */
export function imageTypeOf(path: string): ForgeImageType | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : imageTypes[path.slice(dot + 1).toLowerCase()];
}

/** A repository path as URL segments; `.`, `..` and empty segments could leave the repository. */
function encodedPath(path: string): string {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new ForgeError("invalid_data");
  return segments.map(encodeURIComponent).join("/");
}

function classify(path: string, bytes: Buffer): Whole {
  const size = bytes.length;
  const image = imageTypeOf(path);
  if (image) return { kind: "image", type: image, data: bytes.toString("base64"), size };
  // Git's own test: a NUL in the first 8,000 bytes. Text that isn't UTF-8 is shown as binary.
  if (bytes.subarray(0, 8_000).includes(0)) return { kind: "binary", size };
  try {
    return { kind: "text", text: redact(strict.decode(bytes)), size };
  } catch {
    return { kind: "binary", size };
  }
}

const weigh = (whole: Whole) =>
  whole.kind === "text" ? whole.text.length * 2 : whole.kind === "image" ? whole.data.length : 64;

/**
 * One side of a changed file, for the diffs GitHub withholds (large or binary patches, and files
 * past its 3,000-file list). Files up to 1 MB come inline from the contents API; larger ones up
 * to `forgeFileMaxBytes` from the git blobs API. Text is served in pages cut from the whole.
 */
export class GitHubFileContent {
  readonly #api: GhApi;
  readonly #root: string;
  readonly #cache = new Map<string, Whole>();
  #bytes = 0;
  constructor(api: GhApi, root: string) {
    this.#api = api;
    this.#root = root;
  }
  async read(
    input: { sha: string; path: string; page: number },
    signal: AbortSignal,
  ): Promise<ForgeFileContent> {
    const whole = await this.#whole(sha.parse(input.sha), input.path, signal);
    if (whole.kind !== "text") return whole;
    const start = (input.page - 1) * forgeFileTextPage;
    const end = start + forgeFileTextPage;
    return {
      kind: "text",
      text: whole.text.slice(start, end),
      size: whole.size,
      ...(end < whole.text.length ? { nextPage: input.page + 1 } : {}),
    };
  }
  async #whole(commit: string, path: string, signal: AbortSignal): Promise<Whole> {
    const key = `${commit}:${path}`;
    const known = this.#cache.get(key);
    if (known) {
      this.#cache.delete(key);
      this.#cache.set(key, known);
      return known;
    }
    const whole = await this.#fetch(commit, path, signal);
    this.#keep(key, whole);
    return whole;
  }
  async #fetch(commit: string, path: string, signal: AbortSignal): Promise<Whole> {
    let body: unknown;
    try {
      body = (
        await this.#api.request(`${this.#root}/contents/${encodedPath(path)}?ref=${commit}`, signal)
      ).body;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") return { kind: "missing" };
      throw error;
    }
    // A folder answers with its listing; a submodule names a commit, not content.
    if (Array.isArray(body)) return { kind: "missing" };
    const parsed = Entry.safeParse(body);
    if (!parsed.success) throw new ForgeError("invalid_data");
    const entry = parsed.data;
    if (entry.type === "symlink" && entry.target !== undefined)
      return { kind: "text", text: entry.target, size: Buffer.byteLength(entry.target) };
    if (entry.type !== "file") return { kind: "missing" };
    if (entry.size > forgeFileMaxBytes) return { kind: "large", size: entry.size };
    if (entry.encoding === "base64" && entry.content !== undefined)
      return classify(path, Buffer.from(entry.content, "base64"));
    // Over 1 MB the contents API leaves the bytes out; the blob carries them.
    const blob = Blob.safeParse(
      (await this.#api.request(`${this.#root}/git/blobs/${entry.sha}`, signal)).body,
    );
    if (!blob.success || blob.data.sha !== entry.sha) throw new ForgeError("invalid_data");
    return classify(path, Buffer.from(blob.data.content, "base64"));
  }
  #keep(key: string, whole: Whole): void {
    const kept = this.#cache.get(key);
    if (kept) {
      this.#cache.delete(key);
      this.#bytes -= weigh(kept);
    }
    const bytes = weigh(whole);
    if (bytes > cacheBytes) return;
    while (this.#bytes + bytes > cacheBytes) {
      const oldest = this.#cache.entries().next().value;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#bytes -= weigh(oldest[1]);
    }
    this.#cache.set(key, whole);
    this.#bytes += bytes;
  }
}
