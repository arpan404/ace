import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { writableFolder } from "./download-folder.ts";

it("the app's downloads folder must be a folder it can write on this computer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-desktop-downloads-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await expect(writableFolder(root)).resolves.toBeUndefined();
  await expect(writableFolder("Downloads")).rejects.toThrow(/folder picker/);
  await expect(writableFolder(join(root, "missing"))).rejects.toThrow(/isn't a folder/);
  await writeFile(join(root, "file"), "x");
  await expect(writableFolder(join(root, "file"))).rejects.toThrow(/isn't a folder/);
  const locked = join(root, "locked");
  await mkdir(locked);
  await chmod(locked, 0o500);
  onTestFinished(() => chmod(locked, 0o700));
  if (process.getuid?.() !== 0) await expect(writableFolder(locked)).rejects.toThrow(/can't save/);
});

it.runIf(process.platform === "win32")(
  "Windows: the downloads folder must be one this user can write, whatever its ACL says",
  async () => {
    const { execFile } = await import("node:child_process");
    const { readdir } = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), "ace-desktop-downloads-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(writableFolder(root)).resolves.toBeUndefined();
    // The write check leaves nothing behind.
    expect(await readdir(root)).toEqual([]);
    await expect(writableFolder("Downloads")).rejects.toThrow(/folder picker/);
    await expect(writableFolder(join(root, "missing"))).rejects.toThrow(/isn't a folder/);
    await writeFile(join(root, "file"), "x");
    await expect(writableFolder(join(root, "file"))).rejects.toThrow(/isn't a folder/);
    const locked = join(root, "locked");
    await mkdir(locked);
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await run("icacls", [locked, "/deny", `${user}:(OI)(CI)(W,AD)`]);
    onTestFinished(() => run("icacls", [locked, "/remove:d", user]).then(() => {}));
    await expect(writableFolder(locked)).rejects.toThrow(/can't save/);
  },
);
