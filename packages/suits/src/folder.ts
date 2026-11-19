import { createHash } from "node:crypto";
import {
  isSuitVideoPath,
  type SuitManifest,
  type SuitProblem,
  type SuitSummary,
} from "@ace/protocol/suits";
import {
  fontProblems,
  parseManifest,
  problem,
  readabilityProblems,
  thumbnailProblems,
} from "./checks.ts";
import { suitLimits } from "./limits.ts";
import { regionCss } from "./css/regions.ts";
import { sanitiseSuitCss } from "./css/sanitise.ts";
import { suitSchemes } from "./palette.ts";
import { isSceneFile, regionOrnaments, regionScenes } from "./regions.ts";
import { videoProblems } from "./video.ts";

export { problem };

/*
 * A Suit's folder, decided without touching the disk: which entries a reader may read (`plan`),
 * the folder's content hash, and its summary (`inspectSuit`). The daemon's reader walks the
 * folder with lstat, asks `plan`, reads only what it allows, and hands the bytes back here.
 */

/** One entry under the Suit's folder, as lstat saw it; `path` is relative, with `/`. */
export interface SuitEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  /** Last modification, ms since the epoch; frames a streamed video in the hash. */
  mtimeMs?: number;
}

/** A video the reader never reads: served from disk by range (ADR 0169). */
export interface StreamedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SuitPlan {
  /** Files to read, in path order. */
  read: string[];
  /** Files refused for their size, kept in the hash by path and size. */
  skipped: { path: string; size: number }[];
  /** Videos, in path order: hashed by path, size and modification time, streamed when served. */
  stream: StreamedFile[];
  problems: SuitProblem[];
}

const checkFor = (path: string) =>
  path === "suit.json"
    ? "schema"
    : isSceneFile(path)
      ? "scene"
      : path === "suit.css"
        ? "css"
        : "asset";

/** Files with a cap of their own (every root scene script too); the rest count toward assets. */
const capFor = (path: string): number | undefined =>
  path === "suit.json"
    ? suitLimits.manifestBytes
    : path === "suit.css"
      ? suitLimits.cssBytes
      : isSceneFile(path)
        ? suitLimits.sceneBytes
        : undefined;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a reader may read of `entries`, and the problems the walk itself found. */
export function plan(entries: readonly SuitEntry[]): SuitPlan {
  const result: SuitPlan = { read: [], skipped: [], stream: [], problems: [] };
  const sorted = entries.toSorted((a, b) => byPath(a.path, b.path));
  let assetBytes = 0;
  let files = 0;
  let overAssets = false;
  for (const entry of sorted) {
    const { path } = entry;
    if (path.split("/").length > suitLimits.depth) {
      result.problems.push(problem(checkFor(path), `${path} is nested too deep`, path));
      continue;
    }
    if (entry.kind === "symlink") {
      result.problems.push(
        problem(
          checkFor(path),
          `${path} is a symbolic link; a Suit holds only its own files`,
          path,
        ),
      );
      continue;
    }
    if (entry.kind === "other") {
      result.problems.push(problem(checkFor(path), `${path} is not a regular file`, path));
      continue;
    }
    if (entry.kind === "directory") continue;
    if (++files > suitLimits.files) {
      if (files === suitLimits.files + 1)
        result.problems.push(
          problem("asset", `a Suit holds at most ${suitLimits.files} files`, null),
        );
      result.skipped.push({ path, size: entry.size });
      continue;
    }
    if (isSuitVideoPath(path)) {
      if (entry.size > suitLimits.videoBytes)
        result.problems.push(
          problem(
            "video",
            `${path} is ${entry.size} bytes; a video may be ${suitLimits.videoBytes}`,
            path,
          ),
        );
      else if (result.stream.length >= suitLimits.videos)
        result.problems.push(
          problem("video", `a Suit holds at most ${suitLimits.videos} video files`, path),
        );
      else {
        result.stream.push({ path, size: entry.size, mtimeMs: entry.mtimeMs ?? 0 });
        continue;
      }
      result.skipped.push({ path, size: entry.size });
      continue;
    }
    const cap = capFor(path);
    if (cap !== undefined) {
      if (entry.size > cap) {
        result.problems.push(
          problem(checkFor(path), `${path} is ${entry.size} bytes; the limit is ${cap}`, path),
        );
        result.skipped.push({ path, size: entry.size });
      } else result.read.push(path);
      continue;
    }
    assetBytes += entry.size;
    if (assetBytes > suitLimits.assetBytes) {
      if (!overAssets)
        result.problems.push(
          problem("asset", `assets come to over ${suitLimits.assetBytes} bytes, the limit`, path),
        );
      overAssets = true;
      result.skipped.push({ path, size: entry.size });
      continue;
    }
    result.read.push(path);
  }
  if (!sorted.some((entry) => entry.path === "suit.json"))
    result.problems.push(problem("schema", "the folder has no suit.json", "suit.json"));
  return result;
}

/** A length as 8 bytes, big-endian. */
function length(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

/**
 * sha256 over the folder's files in path order. Each file is framed as a tag, its path's length
 * and bytes, then its content's length and bytes (lengths as 8-byte big-endian), so no two
 * different folders frame to the same stream. A file refused for size is framed by its size; a
 * streamed video by its size and modification time in microseconds, so saving a new cut of it
 * makes a new version without hashing gigabytes on every edit.
 */
export function contentHash(
  files: ReadonlyMap<string, Uint8Array>,
  skipped: readonly { path: string; size: number }[] = [],
  streamed: readonly StreamedFile[] = [],
): string {
  const hash = createHash("sha256").update("ace-suit\u00001\u0000");
  const entries = [
    ...[...files].map(([path, bytes]) => ({
      path,
      tag: "F",
      bytes: bytes as Uint8Array | undefined,
      size: bytes.byteLength,
    })),
    ...skipped.map(({ path, size }) => ({ path, tag: "S", bytes: undefined, size })),
    ...streamed.map(({ path, size, mtimeMs }) => ({
      path,
      tag: "V",
      bytes: length(Math.max(0, Math.round(mtimeMs * 1000))),
      size,
    })),
  ].toSorted((a, b) => byPath(a.path, b.path));
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    hash.update(entry.tag).update(length(path.byteLength)).update(path).update(length(entry.size));
    if (entry.bytes) hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

export interface InspectedSuit {
  summary: SuitSummary;
  /** Undefined when suit.json is missing or doesn't parse. */
  manifest: SuitManifest | undefined;
  /** suit.css as written, for `suitCss`; undefined without one. */
  cssSource: string | undefined;
}

/** Asset paths among the files a reader read. */
const assetPaths = (files: Iterable<string>) =>
  new Set([...files].filter((path) => path.startsWith("assets/")));

/**
 * The Suit's CSS: suit.json's region styles, then suit.css, each sanitised with asset urls
 * pointing at `url(path)`; null with neither. Refusals are already in the summary's problems
 * (`inspectSuit`).
 */
export function suitCss(
  id: string,
  inspected: InspectedSuit,
  assets: Iterable<string>,
  url: (path: string) => string,
): string | null {
  const paths = assetPaths(assets);
  const regions = inspected.manifest?.regions
    ? regionCss({ id, manifest: inspected.manifest, assets: paths, url }).css
    : "";
  const css =
    inspected.cssSource === undefined
      ? ""
      : sanitiseSuitCss({ id, text: inspected.cssSource, assets: paths, url }).css;
  const text = [regions, css].filter(Boolean).join("\n");
  return text === "" && inspected.cssSource === undefined && !inspected.manifest?.regions
    ? null
    : text;
}

/** A Suit's summary from the files `plan` let the reader read, and the plan's own problems. */
export function inspectSuit(
  id: string,
  files: ReadonlyMap<string, Uint8Array>,
  walk: Pick<SuitPlan, "problems" | "skipped"> & Partial<Pick<SuitPlan, "stream">>,
): InspectedSuit {
  const streamed = walk.stream ?? [];
  const problems = [...walk.problems];
  const text = files.get("suit.json");
  const parsed = text ? parseManifest(id, Buffer.from(text).toString("utf8")) : undefined;
  if (parsed) problems.push(...parsed.problems);
  const manifest = parsed?.manifest;
  const scene = files.get("scene.js");
  if (scene && scene.byteLength === 0)
    problems.push(problem("scene", "scene.js is empty; remove it or draw something", "scene.js"));
  const sceneSkipped = walk.skipped.some((entry) => entry.path === "scene.js");
  if (manifest) {
    const present = new Set(files.keys());
    problems.push(...fontProblems(manifest, present));
    problems.push(...thumbnailProblems(manifest, present));
    problems.push(
      ...regionCss({ id, manifest, assets: assetPaths(present), url: (path) => path }).problems,
    );
    problems.push(...regionScenes(manifest, present).problems);
    problems.push(
      ...videoProblems(manifest, present, new Set(streamed.map((video) => video.path))),
    );
    // Only whether each reference lands matters here; the reader serves the real URLs.
    problems.push(
      ...regionOrnaments(manifest, files, (path) => (present.has(path) ? path : undefined))
        .problems,
    );
    // Readability only counts once the manifest itself holds together.
    if (problems.every((entry) => entry.check !== "schema"))
      problems.push(...readabilityProblems(manifest));
  }
  const css = files.get("suit.css");
  const cssSource = css ? Buffer.from(css).toString("utf8") : undefined;
  if (cssSource !== undefined)
    problems.push(
      ...sanitiseSuitCss({
        id,
        text: cssSource,
        assets: assetPaths(files.keys()),
        url: (path) => path,
      }).problems,
    );
  const regionScene =
    manifest !== undefined &&
    Object.keys(regionScenes(manifest, new Set(files.keys())).scenes).length > 0;
  const hasScene = scene !== undefined || sceneSkipped || regionScene;
  return {
    manifest: manifest ? { ...manifest, scene: hasScene } : undefined,
    cssSource,
    summary: {
      id,
      name: manifest?.name ?? id,
      description: manifest?.description ?? "",
      schemes: manifest ? suitSchemes(manifest) : [],
      scene: hasScene,
      contentHash: contentHash(files, walk.skipped, streamed),
      problems,
    },
  };
}
