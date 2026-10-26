import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aboveFloor, assertLinuxRuntimeFloor, elfFiles, elfVersionNeeds } from "./glibc.ts";

/**
 * A little-endian ELF64 shared object with a string table and a `.gnu.version_r` section
 * that needs `versions` from each library, laid out as the linker writes them.
 */
function sharedObject(needs: Record<string, string[]>): Uint8Array {
  const names = ["", ...Object.keys(needs), ...Object.values(needs).flat()];
  const offsets = new Map<string, number>();
  let strings = "";
  for (const name of names) {
    if (offsets.has(name)) continue;
    offsets.set(name, strings.length);
    strings += name + "\0";
  }
  const libraries = Object.entries(needs);
  const verneedSize = libraries.reduce((size, [, versions]) => size + 16 + versions.length * 16, 0);
  const stringsAt = 64;
  const verneedAt = stringsAt + strings.length + ((8 - (strings.length % 8)) % 8);
  const sectionsAt = verneedAt + verneedSize;
  const bytes = new Uint8Array(sectionsAt + 3 * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, 0xb7, true); // aarch64
  view.setBigUint64(0x28, BigInt(sectionsAt), true);
  view.setUint16(0x3a, 64, true);
  view.setUint16(0x3c, 3, true);
  bytes.set(new TextEncoder().encode(strings), stringsAt);
  let at = verneedAt;
  libraries.forEach(([library, versions], index) => {
    const size = 16 + versions.length * 16;
    view.setUint16(at, 1, true);
    view.setUint16(at + 2, versions.length, true);
    view.setUint32(at + 4, offsets.get(library) ?? 0, true);
    view.setUint32(at + 8, 16, true);
    view.setUint32(at + 12, index === libraries.length - 1 ? 0 : size, true);
    versions.forEach((version, position) => {
      const aux = at + 16 + position * 16;
      view.setUint32(aux + 8, offsets.get(version) ?? 0, true);
      view.setUint32(aux + 12, position === versions.length - 1 ? 0 : 16, true);
    });
    at += size;
  });
  const section = (index: number, type: number, offset: number, size: number, link = 0) => {
    const base = sectionsAt + index * 64;
    view.setUint32(base + 4, type, true);
    view.setBigUint64(base + 24, BigInt(offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
    view.setUint32(base + 40, link, true);
    view.setUint32(base + 44, libraries.length, true);
  };
  section(1, 3, stringsAt, strings.length); // SHT_STRTAB
  section(2, 0x6ffffffe, verneedAt, verneedSize, 1);
  return bytes;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Linux runtime floor", () => {
  it("reads the newest glibc and libstdc++ versions a binary needs across its libraries", () => {
    const binary = sharedObject({
      "libc.so.6": ["GLIBC_2.17", "GLIBC_2.34", "GLIBC_2.4"],
      "libstdc++.so.6": ["CXXABI_1.3", "GLIBCXX_3.4.9", "GLIBCXX_3.4.30"],
      "libm.so.6": ["GLIBC_2.29"],
    });
    expect(elfVersionNeeds(binary)).toEqual({ glibc: "2.34", glibcxx: "3.4.30" });
  });

  it("treats a static or libc-free ELF as needing nothing and a non-ELF file as unknown", () => {
    expect(elfVersionNeeds(sharedObject({}))).toEqual({});
    expect(
      elfVersionNeeds(new TextEncoder().encode("#!/bin/sh\necho not a binary\n".repeat(4))),
    ).toBeUndefined();
  });

  it("accepts binaries at the Debian 11 floor and names the ones built on a newer host", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-glibc-"));
    roots.push(root);
    await mkdir(join(root, "node_modules/node-pty/build/Release"), { recursive: true });
    const old = join(root, "node_modules/node-pty/build/Release/pty.node");
    await writeFile(old, sharedObject({ "libc.so.6": ["GLIBC_2.17", "GLIBC_2.31"] }));
    await writeFile(join(root, "README"), "not a binary, long enough to read the header of");
    await assertLinuxRuntimeFloor([root]);

    const newer = join(root, "descriptor.node");
    await writeFile(newer, sharedObject({ "libc.so.6": ["GLIBC_2.39"] }));
    const cxx = join(root, "group-keeper");
    await writeFile(cxx, sharedObject({ "libstdc++.so.6": ["GLIBCXX_3.4.32"] }));
    expect(aboveFloor(await elfFiles([root])).map(({ path }) => path)).toEqual([newer, cxx]);
    await expect(assertLinuxRuntimeFloor([root])).rejects.toThrow(`${newer}: GLIBC_2.39`);
  });

  it("ships Cursor's prebuilt sandbox helper as a reported exception, not a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-glibc-"));
    roots.push(root);
    const bin = join(root, "node_modules/@cursor/sdk-linux-arm64/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cursorsandbox"), sharedObject({ "libc.so.6": ["GLIBC_2.39"] }));
    await expect(assertLinuxRuntimeFloor([root])).resolves.toEqual([
      expect.objectContaining({ path: join(bin, "cursorsandbox"), needs: { glibc: "2.39" } }),
    ]);
    // The same binary anywhere else is not excused.
    await writeFile(join(root, "cursorsandbox"), sharedObject({ "libc.so.6": ["GLIBC_2.39"] }));
    await expect(assertLinuxRuntimeFloor([root])).rejects.toThrow(
      `${join(root, "cursorsandbox")}: GLIBC_2.39`,
    );
  });
});
