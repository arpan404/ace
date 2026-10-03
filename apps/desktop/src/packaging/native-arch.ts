import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type Arch = "x64" | "arm64" | "ia32" | "arm" | "other";
export type BinaryFormat = "mach-o" | "elf" | "pe";
export interface NativeBinary {
  format: BinaryFormat;
  arches: Arch[];
}

/** Bytes read from each file; enough for every header below, including a PE `e_lfanew`. */
export const headerBytes = 4096;

const machO = new Map<number, Arch>([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
  [7, "ia32"],
  [12, "arm"],
]);
const elf = new Map<number, Arch>([
  [0x3e, "x64"],
  [0xb7, "arm64"],
  [0x03, "ia32"],
  [0x28, "arm"],
]);
const pe = new Map<number, Arch>([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
  [0x14c, "ia32"],
]);

/** The native executable format and CPU architectures of a file, from its header. */
export function nativeBinary(header: Uint8Array): NativeBinary | undefined {
  if (header.length < 8) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, false);
  // Thin Mach-O, 32 or 64 bit, either byte order.
  if (magic === 0xcffaedfe || magic === 0xcefaedfe)
    return { format: "mach-o", arches: [machO.get(view.getInt32(4, true)) ?? "other"] };
  if (magic === 0xfeedfacf || magic === 0xfeedface)
    return { format: "mach-o", arches: [machO.get(view.getInt32(4, false)) ?? "other"] };
  // Universal Mach-O. Java class files share the magic but carry a version >= 45 here.
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = view.getUint32(4, false);
    const entry = magic === 0xcafebabe ? 20 : 32;
    if (count === 0 || count > 20 || 8 + count * entry > header.length) return undefined;
    const arches = Array.from(
      { length: count },
      (_value, index) => machO.get(view.getInt32(8 + index * entry, false)) ?? "other",
    );
    return { format: "mach-o", arches };
  }
  if (magic === 0x7f454c46) {
    if (header.length < 20) return undefined;
    const little = header[5] !== 2;
    return { format: "elf", arches: [elf.get(view.getUint16(18, little)) ?? "other"] };
  }
  if (header[0] === 0x4d && header[1] === 0x5a && header.length >= 0x40) {
    const offset = view.getUint32(0x3c, true);
    if (offset + 6 > header.length || view.getUint32(offset, false) !== 0x50450000)
      return undefined;
    return { format: "pe", arches: [pe.get(view.getUint16(offset + 4, true)) ?? "other"] };
  }
  return undefined;
}

const formats: Partial<Record<NodeJS.Platform, BinaryFormat>> = {
  darwin: "mach-o",
  linux: "elf",
  win32: "pe",
};

const archNames = new Map<string, Arch>([
  ["x64", "x64"],
  ["x86_64", "x64"],
  ["amd64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
  ["ia32", "ia32"],
  ["i386", "ia32"],
  ["x86", "ia32"],
]);

/**
 * A binary under a directory named for its own, other architecture (`prebuilds/darwin-x64`,
 * `vendor/ripgrep/x64-darwin`) is a variant its package picks at run time, not one this
 * package runs. Whether the variant for the target exists is checked separately.
 */
function otherArchVariant(path: string, binary: NativeBinary, target: Arch): boolean {
  const named = new Set<Arch>();
  for (const segment of path.split(sep).slice(0, -1))
    for (const token of segment.toLowerCase().split(/[-_.]/)) {
      const arch = archNames.get(token);
      if (arch) named.add(arch);
    }
  // Only an honest variant: the binary is what its directory says, and that is not us.
  return !named.has(target) && named.size > 0 && binary.arches.every((arch) => named.has(arch));
}

/**
 * Every native binary for `platform` under `roots` that cannot run on `target`. The package
 * must not ship if any exist: a mismatched `pty.node` or helper only fails on the user's
 * machine, as "daemon failed".
 */
export async function mismatchedBinaries(
  roots: string[],
  platform: NodeJS.Platform,
  target: Arch,
): Promise<{ path: string; arches: Arch[] }[]> {
  const format = formats[platform];
  if (!format) return [];
  const found: { path: string; arches: Arch[] }[] = [];
  const visit = async (root: string, directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(root, path);
        continue;
      }
      if (!info.isFile() || info.size < 8) continue;
      const file = await open(path, "r");
      let header: Uint8Array;
      try {
        const bytes = Buffer.alloc(Math.min(headerBytes, info.size));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        header = bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      const binary = nativeBinary(header);
      if (!binary || binary.format !== format || binary.arches.includes(target)) continue;
      const shown = relative(root, path);
      if (!otherArchVariant(shown, binary, target)) found.push({ path, arches: binary.arches });
    }
  };
  for (const root of roots) await visit(root, root);
  return found;
}
