import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { relaunchShell } from "./relaunch-after-exit.ts";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "relaunch-after-exit.ts")).href;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-relaunch-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() > deadline) throw new Error(`${path} never appeared`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

/** Runs an "app" that schedules `script` as the relaunch, waits a while, marks `finished`, exits. */
async function runApp(options: {
  script: string;
  args: string[];
  finished: string;
}): Promise<void> {
  const app = `
    const { relaunchAfterExit } = await import(${JSON.stringify(moduleUrl)});
    const { writeFileSync } = await import("node:fs");
    relaunchAfterExit({ execPath: "/bin/sh", args: ["-c", ${JSON.stringify(options.script)}, "x",
      ...${JSON.stringify(options.args)}] });
    setTimeout(() => { writeFileSync(${JSON.stringify(options.finished)}, ""); process.exit(0); }, 400);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", app], { stdio: "inherit" });
  expect(await new Promise((done) => child.on("exit", done))).toBe(0);
}

test.skipIf(process.platform !== "linux")(
  "the relaunched command starts only after the app process has exited",
  async () => {
    const dir = await scratch();
    const finished = join(dir, "finished");
    const seen = join(dir, "seen");
    await runApp({
      script: '[ -f "$1" ] && echo after > "$2" || echo before > "$2"',
      args: [finished, seen],
      finished,
    });
    expect((await waitForFile(seen, 10_000)).trim()).toBe("after");
  },
);

test.skipIf(process.platform !== "linux")(
  "the relaunched app inherits none of the old app's open files, above fd 9 too",
  async () => {
    const dir = await scratch();
    const seen = join(dir, "seen");
    const shell = relaunchShell();
    // Electron leaves descriptors open across exec (IndexedDB locks, the AppImage mount); a
    // shell holding fds 5 and 12 without close-on-exec stands in for it. Node can't: it marks
    // inherited descriptors close-on-exec when it starts. Its stdin at EOF is the app exiting.
    const app = spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec 5>"$1/LOCK" 12>"$1/LOCK"; shift; exec "$@" </dev/null',
        "app",
        dir,
        shell.path,
        "-c",
        shell.script,
        "ace-relaunch",
        "/bin/sh",
        "-c",
        'ls /proc/$$/fd | sort -n | tr "\\n" " " > "$1"',
        "x",
        seen,
      ],
      { stdio: "inherit" },
    );
    expect(app.status).toBe(0);
    // The relaunched shell's own descriptors: stdin, stdout and stderr only.
    const fds = (await waitForFile(seen, 10_000)).trim().split(" ").map(Number);
    expect(fds).toEqual([0, 1, 2]);
  },
);
