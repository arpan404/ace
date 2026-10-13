import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { installCliShim } from "./cli-shim-install.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A home folder and an installed app whose "Node runtime" prints the arguments it gets. */
async function machine() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cli-shim-")));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const resources = await appAt(join(root, "Applications", "ace.app"));
  return { root, home, resources, shim: join(home, ".ace", "bin", "ace") };
}

async function appAt(bundle: string): Promise<string> {
  const resources = join(bundle, "Contents", "Resources");
  await mkdir(join(resources, "runtime", "bin"), { recursive: true });
  await mkdir(join(resources, "daemon"), { recursive: true });
  const node = join(resources, "runtime", "bin", "node");
  await writeFile(node, '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\n');
  await chmod(node, 0o755);
  await writeFile(join(resources, "daemon", "ace.mjs"), "// daemon CLI\n");
  return resources;
}

function install(home: string, resources: string, loginPath = "/usr/bin:/bin") {
  return installCliShim({
    home,
    platform: process.platform,
    node: join(resources, "runtime", "bin", "node"),
    entry: join(resources, "daemon", "ace.mjs"),
    loginPath: async () => loginPath,
  });
}

/** What the bundled runtime received when a terminal ran `ace …`. */
async function runAce(shim: string, ...args: string[]): Promise<string[]> {
  const { stdout } = await run(shim, args, { encoding: "utf8" });
  return stdout.trimEnd().split("\n");
}

describe.skipIf(process.platform === "win32")("the ace command on launch", () => {
  it("replaces a stale ace-legacy shim with one that runs the installed app's bundled CLI", async () => {
    const { home, resources, shim } = await machine();
    await mkdir(join(home, ".ace", "bin"), { recursive: true });
    await writeFile(
      shim,
      [
        "#!/bin/sh",
        "# ace CLI",
        "set -eu",
        'exec "/Applications/ace.app.backup-20260601-150910/Contents/Resources/node" "/Applications/ace.app.backup-20260601-150910/Contents/Resources/app/apps/server/dist/bin.mjs" "$@"',
        "",
      ].join("\n"),
    );
    await chmod(shim, 0o755);

    await expect(install(home, resources)).resolves.toMatchObject({ state: "replaced" });
    expect(await runAce(shim, "doctor", "--json", "two words")).toEqual([
      join(resources, "runtime", "bin", "node"),
      "--disable-warning=ExperimentalWarning",
      join(resources, "daemon", "ace.mjs"),
      "doctor",
      "--json",
      "two words",
    ]);
  });

  it("replaces an earlier unmarked launcher that ran a moved app's daemon/ace.mjs", async () => {
    const { home, resources, shim } = await machine();
    await mkdir(join(home, ".ace", "bin"), { recursive: true });
    await writeFile(
      shim,
      [
        "#!/bin/sh",
        "# ace CLI: runs the daemon CLI bundled in /Applications/ace.app with its own Node runtime.",
        "set -eu",
        'APP="/Applications/ace.app/Contents/Resources"',
        'exec "$APP/runtime/bin/node" --disable-warning=ExperimentalWarning "$APP/daemon/ace.mjs" "$@"',
        "",
      ].join("\n"),
    );
    await expect(install(home, resources)).resolves.toMatchObject({ state: "replaced" });
    expect((await runAce(shim, "status"))[2]).toBe(join(resources, "daemon", "ace.mjs"));
  });

  it("creates the command in a fresh home and leaves a current one untouched on the next launch", async () => {
    const { home, resources, shim } = await machine();
    await expect(install(home, resources)).resolves.toMatchObject({ state: "created" });
    const written = await readFile(shim, "utf8");
    const past = new Date("2026-01-01T00:00:00Z");
    await utimes(shim, past, past);

    await expect(install(home, resources)).resolves.toMatchObject({ state: "unchanged" });
    expect(await readFile(shim, "utf8")).toBe(written);
    expect((await stat(shim)).mtime).toEqual(past);
  });

  it("follows the app to its new folder on the launch after it moves", async () => {
    const { root, home, resources, shim } = await machine();
    await install(home, resources);
    const moved = join(root, "Elsewhere", "ace.app");
    await mkdir(join(root, "Elsewhere"));
    await rename(join(root, "Applications", "ace.app"), moved);

    const movedResources = join(moved, "Contents", "Resources");
    await expect(install(home, movedResources)).resolves.toMatchObject({ state: "replaced" });
    expect((await runAce(shim))[0]).toBe(join(movedResources, "runtime", "bin", "node"));
  });

  it("points at the app's real folder when it was launched through a link", async () => {
    const { root, home, resources, shim } = await machine();
    const link = join(root, "Linked.app");
    await symlink(join(root, "Applications", "ace.app"), link);

    await install(home, join(link, "Contents", "Resources"));
    expect((await runAce(shim))[2]).toBe(join(resources, "daemon", "ace.mjs"));
  });

  it("never overwrites an ace command the person wrote themselves", async () => {
    const { home, resources, shim } = await machine();
    await mkdir(join(home, ".ace", "bin"), { recursive: true });
    const own = '#!/bin/sh\necho "my own ace"\nexec /opt/ace/bin/ace.mjs "$@"\n';
    await writeFile(shim, own);

    await expect(install(home, resources)).resolves.toEqual({ state: "foreign", file: shim });
    expect(await readFile(shim, "utf8")).toBe(own);
  });

  it("leaves a linked ace command and the file it points to alone", async () => {
    const { root, home, resources, shim } = await machine();
    await mkdir(join(home, ".ace", "bin"), { recursive: true });
    const elsewhere = join(root, "custom-ace");
    await writeFile(elsewhere, "#!/bin/sh\nexit 0\n");
    await symlink(elsewhere, shim);

    await expect(install(home, resources)).resolves.toMatchObject({ state: "foreign" });
    expect(await readlink(shim)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("writes nothing when the build has no bundled runtime", async () => {
    const { home, resources, shim } = await machine();
    await rm(join(resources, "runtime"), { recursive: true });

    await expect(install(home, resources)).resolves.toMatchObject({ state: "skipped" });
    await expect(stat(shim)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports whether a terminal's PATH already finds the command", async () => {
    const { home, resources } = await machine();
    const bin = join(home, ".ace", "bin");
    await expect(install(home, resources, "/usr/bin:/bin")).resolves.toMatchObject({
      onPath: false,
      directory: bin,
    });
    await expect(install(home, resources, `/usr/bin:${bin}/:/bin`)).resolves.toMatchObject({
      onPath: true,
    });
  });
});
