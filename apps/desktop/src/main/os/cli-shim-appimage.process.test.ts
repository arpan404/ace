import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
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

/**
 * An app running from an AppImage: its files in a temporary mount, and an `.AppImage` file
 * whose `--appimage-mount` (like the real runtime's) prints a fresh mount point, then stays
 * until it is terminated. `mounted` exists only while such a mount is held.
 */
async function appImage() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cli-appimage-")));
  roots.push(root);
  const mount = join(root, "tmp", ".mount_aceAbc");
  const resources = join(mount, "resources");
  await mkdir(join(resources, "runtime", "bin"), { recursive: true });
  await mkdir(join(resources, "daemon"), { recursive: true });
  const node = join(resources, "runtime", "bin", "node");
  await writeFile(
    node,
    '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\nfor a in "$@"; do [ "$a" = fail ] && exit 3; done\nexit 0\n',
  );
  await chmod(node, 0o755);
  await writeFile(join(resources, "daemon", "ace.mjs"), "// daemon CLI\n");
  const image = join(root, "Applications", "ace.AppImage");
  const mounted = join(root, "mounted");
  const next = join(root, "tmp", ".mount_aceXyz");
  await mkdir(join(root, "Applications"));
  await writeFile(
    image,
    [
      "#!/bin/sh",
      '[ "$1" = --appimage-mount ] || exit 9',
      `touch '${mounted}'`,
      `trap "rm -f '${mounted}'; exit 0" TERM`,
      `echo '${next}'`,
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  await chmod(image, 0o755);
  const home = join(root, "home", ".ace");
  return { root, mount, next, image, mounted, home, shim: join(home, "bin", "ace") };
}

describe.skipIf(process.platform === "win32")("the ace command for an AppImage", () => {
  it("runs the bundled CLI from a fresh mount of the AppImage after the app's own mount is gone", async () => {
    const app = await appImage();
    const result = await installCliShim({
      dataHome: app.home,
      platform: process.platform,
      node: join(app.mount, "resources", "runtime", "bin", "node"),
      entry: join(app.mount, "resources", "daemon", "ace.mjs"),
      loginPath: async () => "/usr/bin:/bin",
      appImage: { image: app.image, mount: app.mount },
    });
    expect(result).toMatchObject({ state: "created" });
    expect(await readFile(app.shim, "utf8")).not.toContain(app.mount);

    // The app quit: its mount is gone; a later command gets a new one.
    await rename(app.mount, app.next);
    const { stdout } = await run(app.shim, ["status", "two words"], { encoding: "utf8" });
    expect(stdout.trimEnd().split("\n")).toEqual([
      join(app.next, "resources", "runtime", "bin", "node"),
      "--disable-warning=ExperimentalWarning",
      join(app.next, "resources", "daemon", "ace.mjs"),
      "status",
      "two words",
    ]);
    // The mount is released when the command ends.
    await expect(stat(app.mounted)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(run(app.shim, ["fail"])).rejects.toMatchObject({ code: 3 });
    await expect(stat(app.mounted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("says where the app was when the AppImage has been moved or deleted", async () => {
    const app = await appImage();
    await installCliShim({
      dataHome: app.home,
      platform: process.platform,
      node: join(app.mount, "resources", "runtime", "bin", "node"),
      entry: join(app.mount, "resources", "daemon", "ace.mjs"),
      loginPath: async () => "/usr/bin:/bin",
      appImage: { image: app.image, mount: app.mount },
    });
    await rm(app.image);
    await expect(run(app.shim, ["status"])).rejects.toMatchObject({
      code: 127,
      stderr: `ace: the ace app is no longer at ${app.image}. Open ace again to repair this command.\n`,
    });
  });
});
