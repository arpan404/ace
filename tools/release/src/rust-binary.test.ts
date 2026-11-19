import { join } from "node:path";
import { expect, test } from "vitest";
import { assertRustLibraries, stagedRustBinary } from "./rust-binary.ts";

test("Linux refuses missing libraries, libva and shipped encoder dependencies", () => {
  assertRustLibraries(
    "ace-files",
    "libgcc_s.so.1 => /lib/libgcc_s.so.1 (0x04)\nlinux-vdso.so.1 (0x01)\nlibc.so.6 => /lib/libc.so.6 (0x02)\n/lib64/ld-linux-x86-64.so.2 (0x03)",
  );
  for (const output of [
    "libva.so.2 => /lib/libva.so.2",
    "libc.so.6 => not found",
    "libavcodec.so.1 => /lib/libavcodec.so.1",
  ])
    expect(() => assertRustLibraries("ace-files", output)).toThrow(
      /ace-files has an unexpected dynamic dependency/,
    );
});

test("Windows stages the executable under its .exe name in the native's folder", () => {
  expect(stagedRustBinary("/bundle", "win32-x64", "files", "ace-files")).toBe(
    join("/bundle", "files", "ace-files.exe"),
  );
});
