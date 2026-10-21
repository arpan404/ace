import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { desktopExecutable } from "@ace/service/desktop-update";
import { bundledDesktopApp, desktopUpdateCli } from "./desktop-update.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An installed app as the desktop build lays it out, whose executable records its launch. */
async function installedApp(version: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-desktop-update-"));
  roots.push(root);
  const daemon = join(root, "ace.app/Contents/Resources/daemon");
  await mkdir(daemon, { recursive: true });
  await writeFile(join(daemon, "desktop-app.json"), JSON.stringify({ version }));
  const executable = desktopExecutable(daemon, process.platform);
  const launched = join(root, "launched");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${launched}'\n`, {
    mode: 0o755,
  });
  return { daemon, launched };
}

const feed = (tags: string[]) => async () =>
  new Response(
    JSON.stringify(tags.map((tag) => ({ tag_name: tag, draft: false, prerelease: false }))),
  );

async function bundled(daemon: string) {
  const app = await bundledDesktopApp(daemon);
  if (!app) throw new Error("The app's marker was not read");
  return app;
}

async function launchedWith(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return readFile(path, "utf8");
}

test("ace update apply inside the desktop app asks the app to install the newer release", async () => {
  const { daemon, launched } = await installedApp("1.0.0");
  const app = await bundled(daemon);
  expect(app.version).toBe("1.0.0");
  const lines: string[] = [];
  await desktopUpdateCli("apply", app, (line) => lines.push(line), feed(["v1.1.0", "v1.0.0"]));
  expect(await launchedWith(launched)).toBe("--ace-update\n");
  expect(lines.join("\n")).toContain("Updating the ace app to 1.1.0");
});

test("ace update check reports the newer release without launching anything", async () => {
  const { daemon, launched } = await installedApp("1.0.0");
  const lines: string[] = [];
  const app = await bundled(daemon);
  await desktopUpdateCli("check", app, (line) => lines.push(line), feed(["v1.1.0"]));
  expect(lines).toEqual([
    "ace 1.1.0 is available (this is 1.0.0). Run `ace update apply` to install it.",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(existsSync(launched)).toBe(false);
});

test("an up-to-date app is not launched by ace update apply", async () => {
  const { daemon, launched } = await installedApp("1.1.0");
  const lines: string[] = [];
  const app = await bundled(daemon);
  await desktopUpdateCli("apply", app, (line) => lines.push(line), feed(["v1.1.0"]));
  expect(lines).toEqual(["ace 1.1.0 is up to date."]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(existsSync(launched)).toBe(false);
});

test("a standalone release has no desktop marker and keeps its own updater", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-standalone-"));
  roots.push(root);
  expect(await bundledDesktopApp(root)).toBeUndefined();
});
