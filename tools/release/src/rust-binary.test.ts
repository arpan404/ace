import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { assertRustLibraries, installRustBinary, stagedRustBinary } from "./rust-binary.ts";

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

test("each native is staged under its shipped service name in its own folder", () => {
  expect(stagedRustBinary("/bundle", "win32-x64", "files", "files")).toBe(
    join("/bundle", "files", "ace Files Service.exe"),
  );
  expect(stagedRustBinary("/bundle", "darwin-arm64", "media", "media")).toBe(
    join("/bundle", "media", "ace Media Service"),
  );
  expect(stagedRustBinary("/bundle", "linux-x64", "history", "history")).toBe(
    join("/bundle", "history", "ace-history-service"),
  );
});

test("staging copies Cargo's build to the shipped name, runnable", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ace-stage-native-"));
  try {
    const built = join(scratch, "target", "ace-media");
    await mkdir(dirname(built), { recursive: true });
    await writeFile(built, "built bytes", { mode: 0o644 });
    const staged = await installRustBinary({
      executable: built,
      root: join(scratch, "bundle"),
      target: "darwin-arm64",
      folder: "media",
      process: "media",
      packageName: "ace-media",
    });
    expect(staged).toBe(join(scratch, "bundle", "media", "ace Media Service"));
    expect(await readFile(staged, "utf8")).toBe("built bytes");
    expect((await stat(staged)).mode & 0o111).not.toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
