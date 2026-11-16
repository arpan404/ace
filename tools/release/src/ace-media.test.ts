import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ReleaseTarget } from "@ace/protocol";
import { mediaLicenseListing, shippedMediaCrates } from "./media-licenses.ts";
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
    await writeFile(
      join(repo, "native/media/Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "ace-media"\nversion = "0.1.0"\n',
    );
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

const crate = (name: string, source: string | null, license: string | null = "MIT") => ({
  id: `${name}-id`,
  name,
  version: "1.0.0",
  license,
  license_file: null,
  manifest_path: `/crates/${name}/Cargo.toml`,
  source,
  authors: [`${name} authors`],
  repository: null,
});
const normal = (pkg: string) => ({ pkg: `${pkg}-id`, dep_kinds: [{ kind: null }] });
const only = (pkg: string, kind: string) => ({ pkg: `${pkg}-id`, dep_kinds: [{ kind }] });
const registry = "registry+https://github.com/rust-lang/crates.io-index";

test("the listing covers crates ace-media links, not dev, build or other members' crates", () => {
  const metadata = {
    packages: [
      crate("ace-media", null),
      crate("media-wire", null),
      crate("media-bench", null),
      crate("serde", registry),
      crate("itoa", registry),
      crate("cc", registry),
      crate("criterion", registry),
      crate("tokio", registry),
    ],
    resolve: {
      nodes: [
        { id: "ace-media-id", deps: [normal("media-wire"), only("cc", "build")] },
        { id: "media-wire-id", deps: [normal("serde"), only("criterion", "dev")] },
        { id: "serde-id", deps: [normal("itoa")] },
        { id: "itoa-id", deps: [] },
        { id: "media-bench-id", deps: [normal("tokio")] },
      ],
    },
  };
  expect(shippedMediaCrates(metadata).map((entry) => entry.name)).toEqual(["itoa", "serde"]);
});

test("each linked crate's notices go into the listing, and a crate with no license stops it", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-media-notices-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "with-file"));
  await writeFile(join(root, "with-file/LICENSE-MIT"), "MIT text from with-file");
  await writeFile(join(root, "with-file/lib.rs"), "fn main() {}");
  await mkdir(join(root, "bare"));
  const shipped = (name: string, license: string | null) => ({
    name,
    version: "2.0.0",
    license,
    licenseFile: null,
    directory: join(root, name),
    authors: ["Someone"],
    repository: `https://example.test/${name}`,
  });
  const listing = await mediaLicenseListing("ace license text", [
    shipped("with-file", "MIT OR Apache-2.0"),
    shipped("bare", "Zlib OR MIT"),
  ]);
  expect(listing).toContain("ace license text");
  expect(listing).toContain("with-file 2.0.0\nLicense: MIT OR Apache-2.0");
  expect(listing).toContain("MIT text from with-file");
  expect(listing).not.toContain("fn main");
  expect(listing).toContain("bare 2.0.0\nLicense: Zlib OR MIT");
  expect(listing).toContain("Source: https://example.test/bare");
  await expect(mediaLicenseListing("ace", [shipped("bare", null)])).rejects.toThrow(
    /declares no license/,
  );
});
