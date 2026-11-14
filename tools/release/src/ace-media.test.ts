import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ReleaseTarget } from "@ace/protocol";
import { assertMediaNoticeListing } from "./licenses.ts";
import { assertMediaLibraries, stageAceMedia, stagedAceMedia } from "./ace-media.ts";

test("Linux refuses missing libraries, libva and shipped encoder dependencies", () => {
  assertMediaLibraries(
    "libgcc_s.so.1 => /lib/libgcc_s.so.1 (0x04)\nlinux-vdso.so.1 (0x01)\nlibc.so.6 => /lib/libc.so.6 (0x02)\n/lib64/ld-linux-x86-64.so.2 (0x03)",
  );
  for (const output of [
    "libva.so.2 => /lib/libva.so.2",
    "libc.so.6 => not found",
    "libavcodec.so.1 => /lib/libavcodec.so.1",
  ])
    expect(() => assertMediaLibraries(output)).toThrow(/unexpected dynamic dependency/);
});

test.runIf(process.platform === "darwin")(
  "staging refuses a wrong version before copying and preserves a matching prebuilt",
  async ({ onTestFinished }) => {
    const repo = await mkdtemp(join(tmpdir(), "ace-media-stage-"));
    onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await mkdir(join(repo, "native/media"), { recursive: true });
    await writeFile(join(repo, "native/media/Cargo.lock"), "version = 4\n");
    await writeFile(
      join(repo, "native/media/Cargo.toml"),
      '[package]\nname = "ace-media"\nversion = "0.1.0"\nedition = "2024"\n[[bin]]\nname = "ace-media"\npath = "main.rs"\n',
    );
    await writeFile(join(repo, "native/media/main.rs"), "fn main() {}\n");
    await writeFile(join(repo, "LICENSE"), "Apache-2.0 notice");
    const source = join(repo, "prebuilt");
    const root = join(repo, "release");
    await writeFile(source, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    const target = ReleaseTarget.parse(`${process.platform}-${process.arch}`);
    const options = { repo, root, target, version: "1.2.4", env: { ACE_MEDIA_BIN: source } };
    await expect(stageAceMedia(options)).rejects.toThrow(/not 1.2.4/);
    await expect(readFile(stagedAceMedia(root, target))).rejects.toThrow();
    await stageAceMedia({ ...options, version: "1.2.3" });
    expect(await readFile(stagedAceMedia(root, target), "utf8")).toContain("echo 1.2.3");
    expect(await readFile(join(root, "media/THIRD-PARTY-LICENSES"), "utf8")).toContain(
      "Apache-2.0 notice",
    );
  },
);

test("unshipped workspace crates do not require notices, but reachable external crates do", () => {
  const workspace = [
    { name: "ace-media", dependencies: [] },
    { name: "media-wire", dependencies: [{ name: "serde", source: "registry+crates.io" }] },
  ];
  expect(() => assertMediaNoticeListing({ packages: workspace })).not.toThrow();
  expect(() =>
    assertMediaNoticeListing({
      packages: [
        { name: "ace-media", dependencies: [{ name: "media-wire", source: null }] },
        workspace[1],
      ],
    }),
  ).toThrow(/update its license listing/);
});
