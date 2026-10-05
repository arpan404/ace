import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { installScreenHelper } from "./index.ts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-install-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "source/AceScreenHelper.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  const binary = Buffer.from("stable executable bytes"),
    plist = Buffer.from("stable plist bytes");
  await writeFile(join(app, "Contents/MacOS/ace-screen-helper"), binary, { mode: 0o755 });
  await writeFile(join(app, "Contents/Info.plist"), plist);
  await writeFile(
    join(root, "source/manifest.json"),
    JSON.stringify({
      bundleId: "dev.ace.screen-helper",
      sha256: hash(binary),
      plistSha256: hash(plist),
    }),
  );
  return { root, app, binary };
}
it("repeated installation retains the same executable inode and bytes", async () => {
  const f = await fixture();
  const destination = join(f.root, "data");
  const path = await installScreenHelper(f.app, destination);
  const first = await stat(path);
  expect(await installScreenHelper(f.app, destination)).toBe(path);
  expect((await stat(path)).ino).toBe(first.ino);
  expect(await readFile(path)).toEqual(f.binary);
});
it("a tampered bundle never installs and never replaces the installed helper", async () => {
  const f = await fixture();
  const destination = join(f.root, "data");
  const path = await installScreenHelper(f.app, destination);
  await writeFile(join(f.app, "Contents/MacOS/ace-screen-helper"), "tampered");
  await expect(installScreenHelper(f.app, join(f.root, "other-data"))).rejects.toThrow(
    "hash mismatch",
  );
  expect(await installScreenHelper(f.app, destination)).toBe(path);
  expect(await readFile(path)).toEqual(f.binary);
});

it("a new helper version installs beside the old one, which keeps its bytes and inode", async () => {
  const f = await fixture();
  const destination = join(f.root, "data");
  const old = await installScreenHelper(f.app, destination);
  const before = await stat(old);
  // The next app build ships a different, correctly signed helper.
  const binary = Buffer.from("next executable bytes");
  await writeFile(join(f.app, "Contents/MacOS/ace-screen-helper"), binary, { mode: 0o755 });
  const plist = await readFile(join(f.app, "Contents/Info.plist"));
  await writeFile(
    join(f.root, "source/manifest.json"),
    JSON.stringify({
      bundleId: "dev.ace.screen-helper",
      sha256: hash(binary),
      plistSha256: hash(plist),
    }),
  );
  const next = await installScreenHelper(f.app, destination);
  expect(next).not.toBe(old);
  expect(await readFile(next)).toEqual(binary);
  expect(await readFile(old)).toEqual(f.binary);
  expect((await stat(old)).ino).toBe(before.ino);
  expect(await installScreenHelper(f.app, destination)).toBe(next);
});

it("an interrupted install is redone instead of blocking every later start", async () => {
  const f = await fixture();
  const destination = join(f.root, "data");
  const path = await installScreenHelper(f.app, destination);
  // A crash between the copy and the manifest leaves a version directory without one.
  const version = join(path, "../../../..");
  await rm(join(version, "manifest.json"));
  await writeFile(join(version, "AceScreenHelper.app/Contents/MacOS/ace-screen-helper"), "partial");
  expect(await installScreenHelper(f.app, destination)).toBe(path);
  expect(await readFile(path)).toEqual(f.binary);
});

it("oversized manifests are rejected without creating an executable installation", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source/manifest.json"), " ".repeat(8192));
  await expect(installScreenHelper(f.app, join(f.root, "data"))).rejects.toThrow(
    "manifest exceeds limit",
  );
  await expect(stat(join(f.root, "data/screen-helper"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("installs a helper whose manifest is kept outside its directory, as in the desktop bundle", async () => {
  const f = await fixture();
  // Contents/Helpers may hold only code; the desktop keeps the manifest in its resources.
  const manifest = join(f.root, "Resources/screen-helper-manifest.json");
  await mkdir(join(f.root, "Resources"));
  await rename(join(f.root, "source/manifest.json"), manifest);
  await expect(installScreenHelper(f.app, join(f.root, "data"))).rejects.toThrow();
  const path = await installScreenHelper(f.app, join(f.root, "data"), manifest);
  expect(await readFile(path)).toEqual(f.binary);
});
