import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mismatchedBinaries, nativeBinary } from "./native-arch.ts";

function header(size = 128): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}
function machO(cpu: number): Uint8Array {
  const { bytes, view } = header();
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, cpu, true);
  return bytes;
}
function universal(...cpus: number[]): Uint8Array {
  const { bytes, view } = header();
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, cpus.length, false);
  cpus.forEach((cpu, index) => view.setInt32(8 + index * 20, cpu, false));
  return bytes;
}
function elf(machine: number): Uint8Array {
  const { bytes, view } = header();
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  view.setUint16(18, machine, true);
  return bytes;
}
function pe(machine: number): Uint8Array {
  const { bytes, view } = header(256);
  bytes.set([0x4d, 0x5a]);
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x50450000, false);
  view.setUint16(0x84, machine, true);
  return bytes;
}
const arm64 = 0x0100000c;
const x64 = 0x01000007;

describe("native binary architectures", () => {
  it("reads the CPU of Mach-O, universal, ELF and PE binaries", () => {
    expect(nativeBinary(machO(arm64))).toEqual({ format: "mach-o", arches: ["arm64"] });
    expect(nativeBinary(universal(x64, arm64))).toEqual({
      format: "mach-o",
      arches: ["x64", "arm64"],
    });
    expect(nativeBinary(elf(0xb7))).toEqual({ format: "elf", arches: ["arm64"] });
    expect(nativeBinary(pe(0x8664))).toEqual({ format: "pe", arches: ["x64"] });
  });

  it("does not mistake scripts, text or Java classes for native code", () => {
    expect(nativeBinary(new TextEncoder().encode("#!/bin/sh\necho hi\n"))).toBeUndefined();
    const { bytes, view } = header();
    view.setUint32(0, 0xcafebabe, false);
    view.setUint32(4, 52, false); // class file version 52
    expect(nativeBinary(bytes)).toBeUndefined();
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tree(files: Record<string, Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "ace-native-arch-"));
  roots.push(root);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

describe("a staged package for one architecture", () => {
  it("passes when every native binary runs on the target", async () => {
    const root = await tree({
      "daemon/descriptor.node": machO(arm64),
      "bin/rg": universal(x64, arm64),
      "daemon/ace.mjs": new TextEncoder().encode("export {};\n"),
    });
    expect(await mismatchedBinaries([root], "darwin", "arm64")).toEqual([]);
  });

  it("names every host-arch binary staged into another arch's package", async () => {
    const root = await tree({
      "daemon/descriptor.node": machO(arm64),
      "daemon/node_modules/node-pty/build/Release/pty.node": machO(arm64),
      "bin/rg": machO(x64),
    });
    const found = await mismatchedBinaries([root], "darwin", "x64");
    expect(found.map((entry) => entry.path.slice(root.length + 1)).toSorted()).toEqual([
      "daemon/descriptor.node",
      "daemon/node_modules/node-pty/build/Release/pty.node",
    ]);
  });

  it("allows a package's variants for other arches, but not a mislabelled one", async () => {
    const root = await tree({
      "sdk/vendor/ripgrep/x64-darwin/rg": machO(x64),
      "sdk/vendor/ripgrep/arm64-darwin/rg": machO(arm64),
      "pty/prebuilds/darwin-x64/pty.node": machO(arm64),
    });
    const found = await mismatchedBinaries([root], "darwin", "arm64");
    expect(found.map((entry) => entry.path.slice(root.length + 1))).toEqual([]);
    const forX64 = await mismatchedBinaries([root], "darwin", "x64");
    expect(forX64.map((entry) => entry.path.slice(root.length + 1)).toSorted()).toEqual([
      "pty/prebuilds/darwin-x64/pty.node",
    ]);
  });

  it("ignores binaries for other operating systems and symlinks", async () => {
    const root = await tree({ "playwright/linux/helper": elf(0x3e) });
    await symlink(join(root, "playwright/linux/helper"), join(root, "link"));
    expect(await mismatchedBinaries([root], "darwin", "arm64")).toEqual([]);
  });
});
