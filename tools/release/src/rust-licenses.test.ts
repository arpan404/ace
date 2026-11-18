import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { licenseListing, shippedCrates } from "./rust-licenses.ts";

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

test.each(["ace-media", "ace-files"])(
  "the listing covers crates %s links, not dev, build or other members' crates",
  (packageName) => {
    const metadata = {
      packages: [
        crate(packageName, null),
        crate("files-wire", null),
        crate("files-bench", null),
        crate("serde", registry),
        crate("itoa", registry),
        crate("cc", registry),
        crate("criterion", registry),
        crate("tokio", registry),
      ],
      resolve: {
        nodes: [
          { id: `${packageName}-id`, deps: [normal("files-wire"), only("cc", "build")] },
          { id: "files-wire-id", deps: [normal("serde"), only("criterion", "dev")] },
          { id: "serde-id", deps: [normal("itoa")] },
          { id: "itoa-id", deps: [] },
          { id: "files-bench-id", deps: [normal("tokio")] },
        ],
      },
    };
    expect(shippedCrates(metadata, packageName).map((entry) => entry.name)).toEqual([
      "itoa",
      "serde",
    ]);
  },
);

test("each linked crate's notices go into the listing, and a crate with no license stops it", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-native-notices-"));
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
  const listing = await licenseListing("ace-files", "ace license text", [
    shipped("with-file", "MIT OR Apache-2.0"),
    shipped("bare", "Zlib OR MIT"),
  ]);
  expect(listing).toContain("ace-files: Apache-2.0");
  expect(listing).toContain("ace license text");
  expect(listing).toContain("with-file 2.0.0\nLicense: MIT OR Apache-2.0");
  expect(listing).toContain("MIT text from with-file");
  expect(listing).not.toContain("fn main");
  expect(listing).toContain("bare 2.0.0\nLicense: Zlib OR MIT");
  expect(listing).toContain("Source: https://example.test/bare");
  await expect(licenseListing("ace-files", "ace", [shipped("bare", null)])).rejects.toThrow(
    /declares no license/,
  );
});
