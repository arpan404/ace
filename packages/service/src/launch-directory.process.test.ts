import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { daemonLaunches, launchEnvironment } from "./daemon-program.ts";

// Real edge: the runtime starts in the entry script's folder, so Bun reads no project
// `bunfig.toml` or `.env`; the entry's first import must take the daemon back to the folder ace
// was started from before any of its code reads `process.cwd()`.
const restore = fileURLToPath(new URL("./launch-directory-entry.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project folder ace is started from, and a release folder holding the entry script. */
function layout(): { project: string; release: string; entry: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ace-launch-directory-")));
  roots.push(root);
  const project = join(root, "project");
  const release = join(root, "release");
  mkdirSync(project);
  mkdirSync(release);
  const entry = join(release, "entry.mjs");
  writeFileSync(
    entry,
    [
      `import ${JSON.stringify(restore)};`,
      `import { resolve } from "node:path";`,
      `process.stdout.write(JSON.stringify({ cwd: process.cwd(), workspace: resolve(process.env.ACE_WORKSPACE_ROOT ?? "."), inherited: process.env.ACE_LAUNCH_CWD ?? null }));`,
    ].join("\n"),
  );
  return { project, release, entry };
}

async function run(entry: string, env: NodeJS.ProcessEnv) {
  const [launch] = daemonLaunches(process.execPath, process.execPath, entry, []);
  if (!launch) throw new Error("no launch");
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  await once(child, "close");
  return { seen: JSON.parse(stdout), stderr, cwd: launch.cwd };
}

test("the daemon starts in its own folder and returns to the one ace was started from", async () => {
  const { project, release, entry } = layout();
  const { seen, cwd } = await run(
    entry,
    launchEnvironment({ ACE_WORKSPACE_ROOT: "./workspace" }, project),
  );
  expect(cwd).toBe(release);
  expect(seen).toEqual({
    cwd: project,
    // A relative setting names what it named before the runtime moved: the project's.
    workspace: join(project, "workspace"),
    // Gone before the daemon's code runs, so none of its children inherit it.
    inherited: null,
  });
});

test("a launch folder that is gone leaves the daemon in its own, saying so without the path", async () => {
  const { project, release, entry } = layout();
  const gone = join(project, "removed");
  const { seen, stderr } = await run(entry, launchEnvironment({}, gone));
  expect(seen.cwd).toBe(release);
  expect(seen.inherited).toBeNull();
  expect(stderr).toMatch(/launch folder/);
  expect(stderr).not.toContain(gone);
});

test("without a launch folder the daemon stays where it was started", async () => {
  const { release, entry } = layout();
  const { seen } = await run(entry, {});
  expect(seen.cwd).toBe(release);
});
