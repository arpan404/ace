import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  CLI_SHIM_MARKER,
  claimHome,
  installedVersion,
  prepareDaemonHome,
  renderLauncher,
  resolveDaemonHome,
  type FreshStartPorts,
} from "./home.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function userHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-home-release-"));
  roots.push(root);
  return root;
}

const ports = (version?: number): FreshStartPorts => ({
  now: () => new Date("2026-10-15T12:00:00.000Z"),
  claim: (root) => claimHome(root),
  ...(version === undefined ? {} : { version }),
});

/** What `install.sh` leaves in a v1 home: a release, its pointers and the launcher. */
async function installRelease(root: string, version: string): Promise<void> {
  const target = `${process.platform}-${process.arch}`;
  const release = `releases/${version}-${target}`;
  await mkdir(join(root, release), { recursive: true });
  await writeFile(
    join(root, release, "release.json"),
    JSON.stringify({ version, target, channel: "stable" }),
  );
  await writeFile(join(root, release, "ace.mjs"), "// daemon\n");
  await symlink(release, join(root, "current"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "ace"), renderLauncher(root), { mode: 0o755 });
}

test("a format bump keeps an install.sh release in the fresh home and backs up only the data", async () => {
  const home = await userHome();
  const root = resolveDaemonHome(home);
  prepareDaemonHome(root, ports());
  await installRelease(root, "1.2.3");
  await writeFile(join(root, "events.sqlite"), "v1 threads");

  const prepared = prepareDaemonHome(root, ports(2));

  expect(prepared).toMatchObject({
    state: "fresh",
    backup: join(home, ".ace-v1"),
    release: "1.2.3",
  });
  // The installation runs from the fresh home exactly as before.
  expect(installedVersion(root)).toBe("1.2.3");
  expect(await readlink(join(root, "current"))).toBe(
    `releases/1.2.3-${process.platform}-${process.arch}`,
  );
  expect((await readdir(root)).toSorted()).toEqual(
    ["ace-format.json", "bin", "current", "releases"].toSorted(),
  );
  // Only the data stays behind.
  expect(await readdir(join(home, ".ace-v1"))).toEqual(
    expect.arrayContaining(["ace-format.json", "events.sqlite"]),
  );
  expect(await readdir(join(home, ".ace-v1"))).not.toContain("releases");
});

test("a 0.x launcher or a desktop shim is never carried into the fresh home", async () => {
  const home = await userHome();
  const root = join(home, ".ace");
  await mkdir(join(root, "bin"), { recursive: true });
  const shim = `#!/bin/sh\n# ${CLI_SHIM_MARKER}\nexec node ace.mjs "$@"\n`;
  await writeFile(join(root, "bin", "ace"), shim, { mode: 0o755 });
  await writeFile(join(root, "state.sqlite"), "0.x data");

  const prepared = prepareDaemonHome(root, ports());

  expect(prepared).toMatchObject({ state: "fresh" });
  expect(prepared).not.toHaveProperty("release");
  expect(await readdir(root)).toEqual(["ace-format.json"]);
  expect(await readFile(join(home, ".ace-v0", "bin", "ace"), "utf8")).toBe(shim);
});

/** `ace service <action>` in a child process, with service managers that record any contact. */
async function service(home: string, root: string, action: string) {
  const bin = join(home, "managers");
  await mkdir(bin, { recursive: true });
  // Not loaded: launchd's 113, systemd's 4.
  for (const [manager, code] of [
    ["launchctl", 113],
    ["systemctl", 4],
  ] as const)
    await writeFile(
      join(bin, manager),
      `#!/bin/sh\necho "$@" >> "${join(home, "contacted")}"\nexit ${code}\n`,
      { mode: 0o755 },
    );
  return promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { serviceCommand } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
       console.log(JSON.stringify(await serviceCommand(${JSON.stringify(root)}, [${JSON.stringify(action)}])));`,
    ],
    { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` } },
  );
}

test("ace service works in a home whose ace command is the desktop app's shim", async () => {
  const home = await userHome();
  const root = resolveDaemonHome(home);
  prepareDaemonHome(root, ports());
  await mkdir(join(root, "bin"));
  const shim = `#!/bin/sh\n# ${CLI_SHIM_MARKER}\nexec '/Applications/ace.app/node' 'ace.mjs' "$@"\n`;
  await writeFile(join(root, "bin", "ace"), shim, { mode: 0o755 });

  const status = await service(home, root, "status");
  expect(JSON.parse(status.stdout.trim())).toEqual({ active: false });

  // Registering one needs an installed release, and says so without touching the manager.
  await expect(service(home, root, "install")).rejects.toThrow(
    /Install a daemon artifact before registering its service: this home's ace command is the desktop app's/,
  );
  expect(await readFile(join(root, "bin", "ace"), "utf8")).toBe(shim);
});
