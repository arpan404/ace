import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
it("tampered bundles and runtime replacement cannot overwrite the installed helper", async () => {
  const f = await fixture();
  const destination = join(f.root, "data");
  const path = await installScreenHelper(f.app, destination);
  await writeFile(join(f.app, "Contents/MacOS/ace-screen-helper"), "tampered");
  await expect(installScreenHelper(f.app, join(f.root, "other-data"))).rejects.toThrow(
    "hash mismatch",
  );
  await writeFile(
    join(f.root, "source/manifest.json"),
    JSON.stringify({
      bundleId: "dev.ace.screen-helper",
      sha256: "a".repeat(64),
      plistSha256: "b".repeat(64),
    }),
  );
  await expect(installScreenHelper(f.app, destination)).rejects.toThrow("upgrade explicitly");
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
