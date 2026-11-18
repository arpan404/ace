import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ReleaseTarget } from "@ace/protocol";
import { filesSizeLimit, aceFilesVersion, stageAceFiles, stagedAceFiles } from "./ace-files.ts";

const host = ReleaseTarget.parse(`${process.platform}-${process.arch}`);

/** A native/files workspace with no dependencies, so `cargo metadata` runs without a registry. */
async function fakeWorkspace(repo: string, version = "0.1.0"): Promise<void> {
  const crate = join(repo, "native/files");
  await mkdir(crate, { recursive: true });
  await writeFile(
    join(crate, "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "ace-files"\nversion = "${version}"\n`,
  );
  await writeFile(
    join(crate, "Cargo.toml"),
    `[package]\nname = "ace-files"\nversion = "${version}"\nedition = "2024"\n[[bin]]\nname = "ace-files"\npath = "main.rs"\n`,
  );
  await writeFile(join(crate, "main.rs"), "fn main() {}\n");
  await writeFile(join(repo, "LICENSE"), "Apache-2.0 notice");
}

test("the hello version is the crate's workspace version, not the app's", async ({
  onTestFinished,
}) => {
  const repo = await mkdtemp(join(tmpdir(), "ace-files-version-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  await fakeWorkspace(repo, "4.5.6");
  expect(aceFilesVersion({ repo, target: host })).toBe("4.5.6");
});

test.runIf(process.platform !== "win32")(
  "staging copies a prebuilt ace-files into files/ with its crate notices",
  async ({ onTestFinished }) => {
    const repo = await mkdtemp(join(tmpdir(), "ace-files-stage-"));
    onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await fakeWorkspace(repo);
    const source = join(repo, "prebuilt");
    const root = join(repo, "release");
    await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await stageAceFiles({ repo, root, target: host, env: { ACE_FILES_BIN: source } })).toBe(
      "prebuilt",
    );
    const staged = join(root, "files", "ace-files");
    expect(stagedAceFiles(root, host)).toBe(staged);
    expect((await stat(staged)).mode & 0o111).not.toBe(0);
    const licenses = await readFile(join(root, "files/THIRD-PARTY-LICENSES"), "utf8");
    expect(licenses).toContain("ace-files: Apache-2.0");
    expect(licenses).toContain("Apache-2.0 notice");
  },
);

test.runIf(process.platform !== "win32")(
  "staging refuses an oversized ace-files before anything is staged",
  async ({ onTestFinished }) => {
    const repo = await mkdtemp(join(tmpdir(), "ace-files-size-"));
    onTestFinished(() => rm(repo, { recursive: true, force: true }));
    await fakeWorkspace(repo);
    const source = join(repo, "prebuilt");
    const root = join(repo, "release");
    await writeFile(source, "");
    await truncate(source, filesSizeLimit + 1);
    await expect(
      stageAceFiles({ repo, root, target: host, env: { ACE_FILES_BIN: source } }),
    ).rejects.toThrow(new RegExp(`ace-files exceeds ${filesSizeLimit} bytes`));
    await expect(readFile(stagedAceFiles(root, host))).rejects.toThrow();
  },
);

test("staging refuses a build for another target host", async ({ onTestFinished }) => {
  const repo = await mkdtemp(join(tmpdir(), "ace-files-host-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  const other = ReleaseTarget.parse(process.platform === "darwin" ? "linux-x64" : "darwin-arm64");
  await expect(
    stageAceFiles({ repo, root: join(repo, "release"), target: other, env: {} }),
  ).rejects.toThrow(new RegExp(`on a ${other} host`));
});
