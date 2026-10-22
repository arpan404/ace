import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { editorLocations, installedEditors } from "./installed-editors.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-linux-editors-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function launcher(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o700);
  return path;
}

/** The per-user launcher folders under the temp home; system ones may hold real editors. */
function userLocations(env: Record<string, string> = {}): string[] {
  return editorLocations("linux", root, env).filter((directory) => directory.startsWith(root));
}

test("Linux discovery finds editors under their distribution names on PATH", async () => {
  const bin = join(root, "bin");
  const zed = await launcher(join(bin, "zeditor"));
  const code = await launcher(join(bin, "codium"));
  const editors = await installedEditors(bin, "linux", userLocations());
  expect(editors).toEqual([
    { id: "code", name: "Visual Studio Code", command: code },
    { id: "zed", name: "Zed", command: zed },
  ]);
});

test("Linux discovery prefers an editor's own launcher over another build's", async () => {
  const bin = join(root, "bin");
  await launcher(join(bin, "codium"));
  const code = await launcher(join(bin, "code"));
  const editors = await installedEditors(bin, "linux", []);
  expect(editors).toEqual([{ id: "code", name: "Visual Studio Code", command: code }]);
});

test("Linux discovery finds per-user Flatpak and JetBrains Toolbox launchers outside PATH", async () => {
  const share = join(root, ".local", "share");
  const sublime = await launcher(join(share, "flatpak/exports/bin/com.sublimetext.three"));
  const idea = await launcher(join(share, "JetBrains/Toolbox/scripts/idea"));
  const editors = await installedEditors("", "linux", userLocations());
  expect(editors).toEqual([
    { id: "subl", name: "Sublime Text", command: sublime },
    { id: "idea", name: "IntelliJ IDEA", command: idea },
  ]);
});

test("Linux discovery follows XDG_DATA_HOME to the user's Flatpak exports", async () => {
  const data = join(root, "data");
  const zed = await launcher(join(data, "flatpak/exports/bin/dev.zed.Zed"));
  await launcher(join(root, ".local/share/flatpak/exports/bin/com.visualstudio.code"));
  const editors = await installedEditors("", "linux", userLocations({ XDG_DATA_HOME: data }));
  expect(editors).toEqual([{ id: "zed", name: "Zed", command: zed }]);
});
