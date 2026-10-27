import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { invoke } from "./cli-test-support.ts";
import { cliVersion } from "./doctor/install.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const root of homes.splice(0)) await rm(root, { recursive: true, force: true });
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "ace-version-"));
  homes.push(root);
  return root;
}

test("ace --version, -v and version print the version without a daemon or a home", async () => {
  const root = await home();
  const data = join(root, "home");
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const output = await invoke(data, args, "", { ACE_VERSION: "1.2.3" });
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout).toBe("1.2.3\n");
  }
  const json = await invoke(data, ["version", "--json"], "", { ACE_VERSION: "1.2.3" });
  expect(json.code, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ version: "1.2.3" });
  // Printing the version never creates the ace home.
  expect(await readdir(root)).toEqual([]);
});

test("an unstamped source checkout reports a development build", async () => {
  const output = await invoke(await home(), ["--version"], "", { ACE_VERSION: undefined });
  expect(output.code, output.stderr).toBe(0);
  expect(output.stdout).toBe("development\n");
});

test("an installed release reads its version off the release folder", async () => {
  const entry = "/home/person/.ace/releases/1.4.0-linux-x64/ace.mjs";
  expect(await cliVersion({}, entry)).toBe("1.4.0");
  expect(await cliVersion({ ACE_VERSION: "not-a-version" }, entry)).toBe("development");
});

test("the CLI bundled in the desktop app reads the app's version beside it, launcher or not", async () => {
  const root = await home();
  // The installed Linux app's layout: /opt/ace/resources/daemon/{ace.mjs,desktop-app.json}.
  const daemon = join(root, "opt", "ace", "resources", "daemon");
  await mkdir(daemon, { recursive: true });
  const entry = join(daemon, "ace.mjs");
  await writeFile(join(daemon, "desktop-app.json"), '{"version":"0.0.12"}\n');
  expect(await cliVersion({}, entry)).toBe("0.0.12");
  // An upgrade replaces the marker with the bundle, so an old launcher reports the new version.
  await writeFile(join(daemon, "desktop-app.json"), '{"version":"0.0.13"}\n');
  expect(await cliVersion({}, entry)).toBe("0.0.13");
  // A stamped version still wins, and an unreadable marker is a development build.
  expect(await cliVersion({ ACE_VERSION: "0.0.14" }, entry)).toBe("0.0.14");
  await writeFile(join(daemon, "desktop-app.json"), "not json");
  expect(await cliVersion({}, entry)).toBe("development");
  await writeFile(join(daemon, "desktop-app.json"), '{"version":"latest"}');
  expect(await cliVersion({}, entry)).toBe("development");
  expect(await cliVersion({}, join(root, "elsewhere", "ace.mjs"))).toBe("development");
});
