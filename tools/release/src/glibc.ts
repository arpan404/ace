import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The oldest C and C++ runtimes a Linux release supports: Debian 11's glibc 2.31 and the
 * libstdc++ of GCC 10 (Ubuntu 20.04, Debian 11). Release natives are built in a Debian 11
 * container (tools/release/linux), so nothing they link needs a newer symbol version.
 */
export const linuxRuntimeFloor = { glibc: "2.31", glibcxx: "3.4.28" } as const;

/** The newest glibc and libstdc++ symbol versions an ELF file requires, when it requires any. */
export interface VersionNeeds {
  glibc?: string;
  glibcxx?: string;
}

const SHT_GNU_VERNEED = 0x6ffffffe;

/**
 * Reads the version needs (`.gnu.version_r`) of an ELF file: what `objdump -T` lists as
 * `GLIBC_2.x` and `GLIBCXX_3.4.x`. Undefined for anything that is not ELF; an ELF without
 * version needs (static, or no libc) gives `{}`.
 */
export function elfVersionNeeds(bytes: Uint8Array): VersionNeeds | undefined {
  if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c)
    return undefined;
  if (bytes[3] !== 0x46) return undefined;
  const wide = bytes[4] === 2;
  const little = bytes[5] !== 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const word = (at: number) => (wide ? Number(view.getBigUint64(at, little)) : u32(at));
  const inside = (at: number, length: number) => at >= 0 && at + length <= bytes.length;
  const sectionTable = word(wide ? 0x28 : 0x20);
  const entrySize = u16(wide ? 0x3a : 0x2e);
  const count = u16(wide ? 0x3c : 0x30);
  const needs: VersionNeeds = {};
  if (!sectionTable || !inside(sectionTable, entrySize * count)) return needs;
  const section = (index: number) => {
    const at = sectionTable + index * entrySize;
    return {
      type: u32(at + 4),
      offset: word(at + (wide ? 24 : 16)),
      size: word(at + (wide ? 32 : 20)),
      link: u32(at + (wide ? 40 : 24)),
      info: u32(at + (wide ? 44 : 28)),
    };
  };
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    const verneed = section(index);
    if (verneed.type !== SHT_GNU_VERNEED || verneed.link >= count) continue;
    const strings = section(verneed.link);
    if (!inside(verneed.offset, verneed.size) || !inside(strings.offset, strings.size)) continue;
    const name = (offset: number) => {
      const start = strings.offset + offset;
      let end = start;
      while (end < strings.offset + strings.size && bytes[end] !== 0) end++;
      return decoder.decode(bytes.subarray(start, end));
    };
    let entry = verneed.offset;
    for (let file = 0; file < verneed.info && inside(entry, 16); file++) {
      let aux = entry + u32(entry + 8);
      for (let version = 0; version < u16(entry + 2) && inside(aux, 16); version++) {
        record(needs, name(u32(aux + 8)));
        const next = u32(aux + 12);
        if (!next) break;
        aux += next;
      }
      const next = u32(entry + 12);
      if (!next) break;
      entry += next;
    }
  }
  return needs;
}

function record(needs: VersionNeeds, symbolVersion: string): void {
  const match = /^(GLIBC|GLIBCXX)_(\d+(?:\.\d+)*)$/.exec(symbolVersion);
  if (!match?.[2]) return;
  const key = match[1] === "GLIBC" ? "glibc" : "glibcxx";
  const current = needs[key];
  if (!current || compareVersions(match[2], current) > 0) needs[key] = match[2];
}

/** Compares dotted numeric versions: negative, zero or positive, like a sort comparator. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export interface ElfNeeds {
  path: string;
  needs: VersionNeeds;
}

/** Every ELF file under `roots` (symlinks are not followed) with its version needs. */
export async function elfFiles(roots: readonly string[]): Promise<ElfNeeds[]> {
  const found: ElfNeeds[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted()) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && info.size >= 52) {
        const needs = elfVersionNeeds(await readFile(path));
        if (needs) found.push({ path, needs });
      }
    }
  };
  for (const root of roots) await visit(root);
  return found;
}

/** The files among `elves` that need a newer glibc or libstdc++ than `floor`. */
export function aboveFloor(
  elves: readonly ElfNeeds[],
  floor: VersionNeeds = linuxRuntimeFloor,
): ElfNeeds[] {
  return elves.filter(({ needs }) =>
    (["glibc", "glibcxx"] as const).some((key) => {
      const needed = needs[key];
      const limit = floor[key];
      return needed !== undefined && limit !== undefined && compareVersions(needed, limit) > 0;
    }),
  );
}

/**
 * Prebuilt third-party binaries known to need more than the floor, which ace cannot rebuild.
 * Each is reviewed: what stops working on an older system, and why the release still ships.
 */
export const knownAboveFloor: readonly { file: RegExp; reason: string }[] = [
  {
    // @cursor/sdk 1.0.35's sandbox helper needs glibc 2.39 (Ubuntu 24.04+, Debian 13+,
    // Fedora 40+). On older systems the Cursor provider's sandboxed commands fail; nothing
    // else uses it, and ace starts and runs other providers normally.
    file: /\/node_modules\/@cursor\/sdk-linux-(?:x64|arm64)\/bin\/cursorsandbox$/,
    reason: "Cursor's prebuilt sandbox helper; Cursor's sandbox needs a newer glibc",
  },
];

/**
 * Throws, naming each file, when anything under `roots` needs a newer runtime than the floor.
 * Returns the reviewed exceptions it found (`knownAboveFloor`), for the caller to report.
 */
export async function assertLinuxRuntimeFloor(
  roots: readonly string[],
): Promise<{ path: string; needs: VersionNeeds; reason: string }[]> {
  const known: { path: string; needs: VersionNeeds; reason: string }[] = [];
  const problems = aboveFloor(await elfFiles(roots)).filter((found) => {
    const exception = knownAboveFloor.find(({ file }) => file.test(found.path));
    if (exception) known.push({ ...found, reason: exception.reason });
    return !exception;
  });
  if (problems.length)
    throw new Error(
      `Linux natives need a newer runtime than glibc ${linuxRuntimeFloor.glibc} / GLIBCXX ${linuxRuntimeFloor.glibcxx}; build them in the Debian 11 container (tools/release/linux):\n  ` +
        problems.map(({ path, needs }) => `${path}: ${describe(needs)}`).join("\n  "),
    );
  return known;
}

export function describe(needs: VersionNeeds): string {
  const parts = [
    needs.glibc ? `GLIBC_${needs.glibc}` : undefined,
    needs.glibcxx ? `GLIBCXX_${needs.glibcxx}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no glibc symbol versions";
}
