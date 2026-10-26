import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test } from "vitest";

/** The tar.gz's `ace-desktop` (scripts/linux-tarball.ts puts it beside Electron). */
const launcher = resolve(import.meta.dirname, "../../build/linux/launcher.sh");

/**
 * An extracted tarball whose Electron records its arguments, on a machine where `unshare -Ur`
 * (the user-namespace probe) succeeds or fails as asked.
 */
async function tarball(namespaces: "work" | "blocked") {
  const root = await mkdtemp(join(tmpdir(), "ace-launcher-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "ace-1.0.0-x64");
  const tools = join(root, "tools");
  await mkdir(app);
  await mkdir(tools);
  await copyFile(launcher, join(app, "ace-desktop"));
  await chmod(join(app, "ace-desktop"), 0o755);
  const record = join(root, "args");
  await writeFile(join(app, "ace-desktop-bin"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
  await chmod(join(app, "ace-desktop-bin"), 0o755);
  await writeFile(join(tools, "unshare"), `#!/bin/sh\nexit ${namespaces === "work" ? 0 : 1}\n`);
  await chmod(join(tools, "unshare"), 0o755);
  const start = (command: string, args: string[] = []) => {
    const run = spawnSync(command, args, {
      encoding: "utf8",
      env: { PATH: `${tools}:/usr/bin:/bin` },
    });
    return { status: run.status, stderr: run.stderr };
  };
  const received = async () => (await readFile(record, "utf8")).split("\n").filter(Boolean);
  return { root, app, start, received };
}

test("where user namespaces work, Electron starts with its sandbox and the person's arguments", async () => {
  const { app, start, received } = await tarball("work");
  expect(start(join(app, "ace-desktop"), ["ace://t/1"]).status).toBe(0);
  expect(await received()).toEqual(["ace://t/1"]);
});

test("where AppArmor blocks them, Electron starts without its sandbox instead of aborting", async () => {
  const { app, start, received } = await tarball("blocked");
  const run = start(join(app, "ace-desktop"), ["ace://t/1"]);
  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/without Chromium's sandbox/);
  expect(await received()).toEqual(["--no-sandbox", "ace://t/1"]);
});

test("a person's own --no-sandbox is passed through once", async () => {
  const { app, start, received } = await tarball("blocked");
  start(join(app, "ace-desktop"), ["--no-sandbox"]);
  expect(await received()).toEqual(["--no-sandbox"]);
});

test("started through a symlink, the launcher still finds Electron beside itself", async () => {
  const { root, app, start, received } = await tarball("work");
  await symlink(join(app, "ace-desktop"), join(root, "ace"));
  expect(start(join(root, "ace")).status).toBe(0);
  expect(await received()).toEqual([]);
});
