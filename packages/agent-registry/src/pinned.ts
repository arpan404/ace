import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/*
 * Approved executables, pinned (ADR 0044 amendment, agents that update themselves). A launch
 * hashes the approved file, then runs it; an agent that rewrites itself between the two would
 * run unseen bytes. So an approved single-file native executable is copied once per approved
 * digest into ace's own store (`<dataDir>/agent-registry/pinned/<digest>/<name>`, read-only),
 * the copy is hashed, and launches run the copy. A script, or a native executable that loads
 * files beside it by its own path, can't be pinned this way: it keeps running in place, hashed
 * at each launch.
 */

/** Hashes a file, reusing a digest while the file holds still (`ExecutableDigests`). */
export interface FileDigests {
  digest(path: string): Promise<string>;
}

const maxBytes = 512 * 1024 * 1024;
/** Load paths relative to the executable itself: such a binary needs the files beside it. */
const siblingMarkers = ["@executable_path", "@loader_path", "$ORIGIN"].map((text) =>
  Buffer.from(text),
);
const markerTail = Math.max(...siblingMarkers.map((marker) => marker.length)) - 1;
/** Written in place of a copy: this digest runs in place, so it isn't read again each launch. */
const inPlaceMarker = "in-place";

/** ELF, Mach-O (thin, either byte order, and universal) or a Windows PE. */
export function nativeExecutable(start: Buffer): boolean {
  if (start.length >= 4 && start.readUInt32BE(0) === 0x7f454c46) return true;
  if (
    start.length >= 4 &&
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
      start.readUInt32BE(0),
    )
  )
    return true;
  return start.length >= 2 && start[0] === 0x4d && start[1] === 0x5a;
}

async function head(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Copies `from` to `to`, hashing what was written and noting a sibling load path. */
async function copyHashed(from: string, to: string): Promise<{ digest: string; shared: boolean }> {
  const hash = createHash("sha256");
  let bytes = 0;
  let shared = false;
  let tail = Buffer.alloc(0);
  const watch = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new Error("Executable exceeds bound"));
      hash.update(chunk);
      if (!shared) {
        const window = Buffer.concat([tail, chunk]);
        shared = siblingMarkers.some((marker) => window.includes(marker));
        tail = window.subarray(Math.max(0, window.length - markerTail));
      }
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(from), watch, createWriteStream(to, { mode: 0o700 }));
  return { digest: hash.digest("hex"), shared };
}

export class PinnedExecutables {
  readonly #root: string;
  readonly #digests: FileDigests;
  readonly #platform: NodeJS.Platform;
  /** One copy per digest at a time. */
  #copying = new Map<string, Promise<string | undefined>>();
  constructor(root: string, digests: FileDigests, platform: NodeJS.Platform) {
    this.#root = root;
    this.#digests = digests;
    this.#platform = platform;
  }
  /**
   * The pinned copy of `path`, approved as `digest`: made once, checked against `digest` at every
   * call (a stat while it holds still). Undefined when `path` runs in place: a script, or a
   * native executable that needs the files beside it. Rejects when the file on disk no longer
   * hashes to `digest`.
   */
  pin(path: string, digest: string): Promise<string | undefined> {
    const running = this.#copying.get(digest);
    if (running) return running;
    const task = this.#pin(path, digest).finally(() => this.#copying.delete(digest));
    this.#copying.set(digest, task);
    return task;
  }
  async #pin(path: string, digest: string): Promise<string | undefined> {
    const folder = join(this.#root, digest);
    const target = join(folder, basename(path));
    if (await exists(join(folder, inPlaceMarker))) return undefined;
    if (await exists(target)) {
      if ((await this.#digests.digest(target).catch(() => undefined)) === digest) return target;
      await rm(folder, { recursive: true, force: true });
    }
    if (!nativeExecutable(await head(path))) return undefined;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (this.#platform === "win32" && (await hasLibraries(dirname(path)))) {
      await writeFile(join(folder, inPlaceMarker), "");
      return undefined;
    }
    const partial = join(folder, ".partial");
    const copied = await copyHashed(path, partial).catch(async (error: unknown) => {
      await rm(partial, { force: true });
      throw error;
    });
    if (copied.digest !== digest) {
      await rm(folder, { recursive: true, force: true });
      throw new Error("Approved executable changed while ace pinned it");
    }
    if (copied.shared) {
      await rm(partial, { force: true });
      await writeFile(join(folder, inPlaceMarker), "");
      return undefined;
    }
    await chmod(partial, 0o500);
    await rename(partial, target);
    return target;
  }
  /** Removes pinned copies of digests no installation runs any more. Best effort. */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.#root).catch(() => []);
    for (const entry of entries)
      if (/^[a-f0-9]{64}$/.test(entry) && !keep.has(entry) && !this.#copying.has(entry))
        await rm(join(this.#root, entry), { recursive: true, force: true }).catch(() => {});
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A Windows program loads DLLs from its own folder first, so one beside it needs that folder. */
async function hasLibraries(folder: string): Promise<boolean> {
  const entries = await readdir(folder).catch(() => []);
  return entries.some((entry) => /\.dll$/i.test(entry));
}
