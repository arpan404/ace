import type { BigIntStats, Stats } from "node:fs";
import { z } from "zod";

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const FileIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("posix"), dev: decimal, ino: decimal }),
  z.object({
    kind: z.literal("win32"),
    vol: z.string().regex(/^[0-9a-f]{16}$/),
    id: z.string().regex(/^[0-9a-f]{32}$/),
  }),
]);
export type FileIdentity = z.infer<typeof FileIdentitySchema>;
export type IdentifiedStats = Stats & { identity: FileIdentity };

/** Identity domains stay distinct. Numeric Stats fields are display metadata only. */
export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  if (a.kind === "posix" && b.kind === "posix") return a.dev === b.dev && a.ino === b.ino;
  return a.kind === "win32" && b.kind === "win32" && a.vol === b.vol && a.id === b.id;
}

function milliseconds(ns: bigint): number {
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000;
}

/** Convert one atomic bigint stat observation, retaining its exact identity.
 * Node's Windows dev/ino do not contain FILE_ID_INFO, even with bigint enabled.
 * Windows observations must supply that separate native identity instead.
 */
export function posixStats(info: BigIntStats): IdentifiedStats {
  return identifiedStats(info, { kind: "posix", dev: String(info.dev), ino: String(info.ino) });
}

export function identifiedStats(info: BigIntStats, identity: FileIdentity): IdentifiedStats {
  const result = {
    identity,
    dev: Number(info.dev),
    ino: Number(info.ino),
    mode: Number(info.mode),
    nlink: Number(info.nlink),
    uid: Number(info.uid),
    gid: Number(info.gid),
    rdev: Number(info.rdev),
    size: Number(info.size),
    blksize: Number(info.blksize),
    blocks: Number(info.blocks),
    atimeMs: milliseconds(info.atimeNs),
    mtimeMs: milliseconds(info.mtimeNs),
    ctimeMs: milliseconds(info.ctimeNs),
    birthtimeMs: milliseconds(info.birthtimeNs),
    atime: info.atime,
    mtime: info.mtime,
    ctime: info.ctime,
    birthtime: info.birthtime,
    get atimeInstant() {
      return info.atimeInstant;
    },
    get mtimeInstant() {
      return info.mtimeInstant;
    },
    get ctimeInstant() {
      return info.ctimeInstant;
    },
    get birthtimeInstant() {
      return info.birthtimeInstant;
    },
    isFile: () => info.isFile(),
    isDirectory: () => info.isDirectory(),
    isBlockDevice: () => info.isBlockDevice(),
    isCharacterDevice: () => info.isCharacterDevice(),
    isSymbolicLink: () => info.isSymbolicLink(),
    isFIFO: () => info.isFIFO(),
    isSocket: () => info.isSocket(),
  };
  // Match Node's lazy, nonenumerable Temporal getters. Reading them may throw
  // when Temporal is unavailable; ordinary stat reads and JSON must not do so.
  return Object.defineProperties(result, {
    atimeInstant: { enumerable: false },
    mtimeInstant: { enumerable: false },
    ctimeInstant: { enumerable: false },
    birthtimeInstant: { enumerable: false },
  });
}
