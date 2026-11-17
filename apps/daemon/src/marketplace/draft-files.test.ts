import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readFolder } from "./draft-files.ts";

/* A draft folder's files: hidden and credential-shaped files stay home, and limits hold. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folderWith(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "ace-draft-files-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test("hidden files and folders and credential-shaped files are left out, each said why", async () => {
  const root = await folderWith({
    "SKILL.md": "---\nname: x\n---\nDo it.\n",
    "scripts/run.sh": "#!/bin/sh\n",
    ".env": "TOKEN=1",
    ".env.production": "TOKEN=2",
    ".config/app/settings.json": "{}",
    ".DS_Store": "x",
    "keys/server.pem": "x",
    "keys/signing.key": "x",
    "keys/id_ed25519": "x",
    "keys/id_rsa.pub": "x",
    "store/cert.p12": "x",
    "store/app.pfx": "x",
    "credentials.json": "{}",
    "aws-credentials": "x",
    "notes/.npmrc": "x",
    "notes/.netrc": "x",
    "release.keystore": "x",
  });
  const read = await readFolder(root);
  expect(read.files.map((file) => file.path).toSorted()).toEqual(["SKILL.md", "scripts/run.sh"]);
  expect(Object.fromEntries(read.excluded.map((item) => [item.path, item.reason]))).toEqual({
    ".env": "hidden",
    ".env.production": "hidden",
    ".config": "hidden",
    ".DS_Store": "hidden",
    "keys/server.pem": "credential",
    "keys/signing.key": "credential",
    "keys/id_ed25519": "credential",
    "keys/id_rsa.pub": "credential",
    "store/cert.p12": "credential",
    "store/app.pfx": "credential",
    "credentials.json": "credential",
    "aws-credentials": "credential",
    "notes/.npmrc": "hidden",
    "notes/.netrc": "hidden",
    "release.keystore": "credential",
  });
});

test("a folder past the file count or one file past its size is refused", async () => {
  const many = await folderWith(
    Object.fromEntries(Array.from({ length: 6 }, (_, at) => [`f${at}.md`, "x"])),
  );
  await expect(readFolder(many, { files: 5, fileBytes: 100, totalBytes: 1000 })).rejects.toThrow(
    /more than 5 files/,
  );
  const large = await folderWith({ "big.md": "x".repeat(200) });
  await expect(readFolder(large, { files: 5, fileBytes: 100, totalBytes: 1000 })).rejects.toThrow(
    /big\.md is larger than/,
  );
});
