import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished, test } from "vitest";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "relaunch-after-exit.ts")).href;

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

test.skipIf(process.platform === "win32")(
  "the relaunched command starts only after the app process has exited",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-relaunch-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const finished = join(dir, "finished");
    const seen = join(dir, "seen");
    // The app: schedules the relaunch, keeps working a while, marks its last step, exits.
    const app = `
      const { relaunchAfterExit } = await import(${JSON.stringify(moduleUrl)});
      const { writeFileSync } = await import("node:fs");
      relaunchAfterExit({
        execPath: "/bin/sh",
        args: ["-c", '[ -f "$1" ] && echo after > "$2" || echo before > "$2"', "x",
          ${JSON.stringify(finished)}, ${JSON.stringify(seen)}],
      });
      setTimeout(() => { writeFileSync(${JSON.stringify(finished)}, ""); process.exit(0); }, 400);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", app], { stdio: "inherit" });
    const code = await new Promise((done) => child.on("exit", done));
    expect(code).toBe(0);
    expect((await waitForFile(seen, 10_000)).trim()).toBe("after");
  },
);
