import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCommandRunner } from "./command.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ace-forge-command-"));
  directories.push(directory);
  return directory;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe.runIf(process.platform === "win32")("Windows forge commands", () => {
  test("a gh.exe inside the checkout never runs in place of the installed GitHub CLI", async () => {
    const checkout = await scratch();
    // Node answers --version with its own "v24..." line, never "gh version".
    await copyFile(process.execPath, join(checkout, "gh.exe"));
    const run = createCommandRunner({ cwd: checkout });
    const result = await run({
      command: "gh",
      args: ["--version"],
      mode: "json",
      signal: new AbortController().signal,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^gh version /);
  });

  test("cancelling a command also ends the processes it started", async () => {
    const directory = await scratch();
    const record = join(directory, "grandchild.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(record)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const run = createCommandRunner({ cwd: directory, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = run({
      command: "node",
      args: ["-e", script],
      mode: "tail",
      signal: controller.signal,
    });
    const settled = pending.then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.name : "failed"),
    );
    expect(await until(() => readFile(record, "utf8").then(Boolean, () => false))).toBe(true);
    const grandchild = Number(await readFile(record, "utf8"));
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    expect(await settled).not.toBe("finished");
    expect(await until(() => !alive(grandchild))).toBe(true);
  });
});
