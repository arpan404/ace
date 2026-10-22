import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { terminalCommand } from "./cli-command.ts";
import { putCliOnPath, takeCliOffPath, type CliPathTarget } from "./cli-path-install.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A home folder with the app's `ace` shim in `~/.ace/bin`, for a person whose shell is `shell`. */
async function machine(shell = "/bin/zsh", homeName = "home") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cli-path-")));
  roots.push(root);
  const home = join(root, homeName);
  const directory = join(home, ".ace", "bin");
  const file = join(directory, "ace");
  await mkdir(directory, { recursive: true });
  await writeFile(file, "#!/bin/sh\necho ace-from-app\n");
  await chmod(file, 0o755);
  const target: CliPathTarget = {
    platform: "darwin",
    home,
    directory,
    file,
    env: { SHELL: shell },
  };
  return { root, home, target };
}

/** What a terminal prints for `ace` after reading `startup` (or with `path` alone). */
async function terminalRuns(home: string, path: string, startup?: string): Promise<string> {
  const source = startup ? `. "${startup}"; ` : "";
  const { stdout } = await run("/bin/sh", ["-c", `${source}ace`], {
    env: { HOME: home, PATH: path },
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stderr ?? error.stdout ?? "",
  }));
  return stdout.trim();
}

describe("putting the ace command on a terminal's PATH", () => {
  it("adds a PATH line to .zshrc that a new terminal picks up, and takes only it back", async () => {
    const { home, target } = await machine();
    const zshrc = join(home, ".zshrc");
    const own = "export EDITOR=vim\n";
    await writeFile(zshrc, own);

    await expect(putCliOnPath(target, "/usr/bin:/bin")).resolves.toEqual({
      state: "added",
      files: [zshrc],
    });
    await putCliOnPath(target, "/usr/bin:/bin");
    expect(await terminalRuns(home, "/usr/bin:/bin", zshrc)).toBe("ace-from-app");

    await expect(takeCliOffPath(target)).resolves.toEqual({ state: "off", command: target.file });
    expect(await readFile(zshrc, "utf8")).toBe(own);
  });

  it("edits the file a dotfiles link points to and keeps the link", async () => {
    const { root, home, target } = await machine();
    const dotfiles = join(root, "dotfiles", "zshrc");
    await mkdir(join(root, "dotfiles"));
    await writeFile(dotfiles, "# mine\n");
    await symlink(dotfiles, join(home, ".zshrc"));

    await putCliOnPath(target, "/usr/bin:/bin");

    expect(await readlink(join(home, ".zshrc"))).toBe(dotfiles);
    expect(await readFile(dotfiles, "utf8")).toContain(target.directory.slice(home.length));
  });

  it("links into ~/.local/bin when that folder is on PATH, so open terminals run it too", async () => {
    const { home, target } = await machine();
    const localBin = join(home, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    const path = `/usr/bin:/bin:${localBin}`;

    await expect(putCliOnPath(target, path)).resolves.toEqual({
      state: "ready",
      command: join(localBin, "ace"),
    });
    expect(await terminalRuns(home, path)).toBe("ace-from-app");
    // Read again on the next launch: the link is this app's command.
    await expect(putCliOnPath(target, path)).resolves.toMatchObject({ state: "ready" });

    await takeCliOffPath(target);
    await expect(lstat(join(localBin, "ace"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves PATH and startup files alone when another ace is first on PATH", async () => {
    const { root, home, target } = await machine();
    const other = join(root, "brew", "bin");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "ace"), "#!/bin/sh\necho other\n");
    await chmod(join(other, "ace"), 0o755);

    await expect(putCliOnPath(target, `${other}:/usr/bin`)).resolves.toEqual({
      state: "other",
      command: join(other, "ace"),
    });
    await expect(lstat(join(home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("puts a folder with spaces and quotes on PATH once, however often bash reads it", async () => {
    const { home, target } = await machine("/bin/bash", 'my $home "x"');
    await putCliOnPath(target, "/usr/bin:/bin");
    const bashrc = join(home, ".bashrc");
    const { stdout } = await run(
      "/bin/sh",
      ["-c", '. "$1"; . "$1"; printf %s "$PATH"', "sh", bashrc],
      { env: { HOME: home, PATH: "/usr/bin:/bin" } },
    );
    expect(stdout.split(":")).toEqual([target.directory, "/usr/bin", "/bin"]);
  });

  it("never overwrites a fish file of the person's own", async () => {
    const { home, target } = await machine("/usr/local/bin/fish");
    const file = join(home, ".config", "fish", "conf.d", "ace.fish");
    await mkdir(join(home, ".config", "fish", "conf.d"), { recursive: true });
    await writeFile(file, "set -gx ACE 1\n");

    await expect(putCliOnPath(target, "/usr/bin")).resolves.toMatchObject({
      state: "manual",
      directory: target.directory,
    });
    await takeCliOffPath(target);
    expect(await readFile(file, "utf8")).toBe("set -gx ACE 1\n");
  });
});

describe("the ace command setting", () => {
  it("turned back on, adds the line again even though launch's PATH already had the folder", async () => {
    const { home, target } = await machine();
    let enabled = true;
    const control = terminalCommand({
      shim: Promise.resolve({ state: "unchanged", file: target.file, directory: target.directory }),
      enabled: () => enabled,
      save: async (on) => void (enabled = on),
      target: { platform: target.platform, home, env: target.env },
      // Launch read the PATH while ace's line was still in .zshrc.
      launchPath: async () => `${target.directory}:/usr/bin`,
      freshPath: async () => "/usr/bin:/bin",
      log: () => {},
    });
    await expect(control.status()).resolves.toMatchObject({ state: "ready" });

    await expect(control.set(false)).resolves.toMatchObject({ state: "off" });
    await expect(control.set(true)).resolves.toEqual({
      state: "added",
      files: [join(home, ".zshrc")],
    });
    expect(enabled).toBe(true);
    expect(await terminalRuns(home, "/usr/bin:/bin", join(home, ".zshrc"))).toBe("ace-from-app");
  });

  it("changes nothing on launch while it is off", async () => {
    const { home, target } = await machine();
    const control = terminalCommand({
      shim: Promise.resolve({ state: "created", file: target.file, directory: target.directory }),
      enabled: () => false,
      save: async () => {},
      target: { platform: target.platform, home, env: target.env },
      launchPath: async () => "/usr/bin:/bin",
      freshPath: async () => "/usr/bin:/bin",
      log: () => {},
    });
    await expect(control.status()).resolves.toEqual({ state: "off", command: target.file });
    await expect(lstat(join(home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
