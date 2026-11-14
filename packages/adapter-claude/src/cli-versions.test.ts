import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CliVersions } from "./cli-versions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** A Mach-O header: what a native Claude CLI starts with. */
const native = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
/** Hashing a minute from now: every file written here counts as settled. */
const later = () => Date.now() + 60_000;
async function installed(layout: string, content: string | Buffer = native) {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-versions-"));
  roots.push(root);
  const path = join(root, layout);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, { mode: 0o755 });
  return { root, path };
}
/** A probe that answers `reported` and counts how often the CLI was asked. */
function asked(reported: () => string) {
  const probe = Object.assign(async () => {
    probe.count++;
    return `${reported()} (Claude Code)`;
  }, { count: 0 });
  return probe;
}

it.each([
  ["the native installer", "versions/2.1.286"],
  ["the Homebrew cask", "claude-code/2.1.286/claude"],
])("a direct installation from %s is asked its version once", async (_name, layout) => {
  const { path } = await installed(layout);
  const versions = new CliVersions(later);
  const probe = asked(() => "2.1.286");
  for (let open = 0; open < 3; open++) expect(await versions.read(path, probe)).toContain("2.1.286");
  expect(probe.count).toBe(1);
});

it.each([
  ["a script, however large", "versions/2.1.286", `#!/bin/sh\n# ${"x".repeat(128 * 1024)}\n`],
  ["a native launcher whose path names no version", "bin/claude", native],
])("%s is asked its version on every open", async (_name, layout, content) => {
  const { path } = await installed(layout, content);
  const versions = new CliVersions(later);
  const probe = asked(() => "2.1.286");
  for (let open = 0; open < 3; open++) await versions.read(path, probe);
  expect(probe.count).toBe(3);
});

it("an installation written moments ago is asked again: a second write could keep its times", async () => {
  const { path } = await installed("versions/2.1.286");
  const versions = new CliVersions(Date.now);
  const probe = asked(() => "2.1.286");
  for (let open = 0; open < 2; open++) await versions.read(path, probe);
  expect(probe.count).toBe(2);
});

it("a direct installation changed in place is asked again", async () => {
  const { path } = await installed("versions/2.1.286");
  const versions = new CliVersions(later);
  const probe = asked(() => "2.1.286");
  await versions.read(path, probe);
  await appendFile(path, "patched");
  await versions.read(path, probe);
  expect(probe.count).toBe(2);
});

it("a link moved to another installation reads that installation's version", async () => {
  const { root, path: first } = await installed("versions/2.1.286");
  const second = join(root, "versions/2.1.300");
  await writeFile(second, native, { mode: 0o755 });
  const link = join(root, "claude");
  await symlink(first, link);
  let current = "2.1.286";
  const versions = new CliVersions(later);
  const probe = asked(() => current);
  await versions.read(link, probe);
  await rm(link);
  await symlink(second, link);
  current = "2.1.300";
  expect(await versions.read(link, probe)).toContain("2.1.300");
  expect(probe.count).toBe(2);
});

it("a version another installation answered while the link moved is never kept for the first", async () => {
  const { path } = await installed("versions/2.1.286");
  const versions = new CliVersions(later);
  // The link pointed elsewhere for the probe: what answered was not this file.
  let current = "2.1.200";
  const probe = asked(() => current);
  expect(await versions.read(path, probe)).toContain("2.1.200");
  current = "2.1.286";
  expect(await versions.read(path, probe)).toContain("2.1.286");
  expect(probe.count).toBe(2);
});
