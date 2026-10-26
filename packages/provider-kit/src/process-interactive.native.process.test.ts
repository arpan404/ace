import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { spawnInteractive, type InteractiveProcess } from "./process-interactive.ts";

const directories: string[] = [];
const handles: InteractiveProcess[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop({ graceMs: 0 })));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function track(handle: InteractiveProcess): InteractiveProcess {
  handles.push(handle);
  return handle;
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-login-"));
  directories.push(root);
  return root;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  await expect
    .poll(() =>
      readFile(path, "utf8").then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  return JSON.parse(await readFile(path, "utf8"));
}

// Real taskkill, Job Object and cmd.exe on a Windows host.
describe.runIf(process.platform === "win32")("Windows interactive login", () => {
  test("a login that exits reports its own exit code", async () => {
    const proc = track(
      spawnInteractive({ command: process.execPath, args: ["-e", "process.exit(3)"], env: {} }),
    );
    expect(await proc.exited).toEqual({ code: 3, signal: null, reason: "exit" });
  });

  test("stopping a login ends the login and the child it started", async () => {
    const record = join(await directory(), "pids.json");
    const proc = track(
      spawnInteractive({
        command: process.execPath,
        args: [
          "-e",
          "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
            "require('node:fs').writeFileSync(process.env.ACE_RECORD,JSON.stringify([process.pid,c.pid]));" +
            "setInterval(()=>{},1000);",
        ],
        env: { ...process.env, ACE_RECORD: record },
      }),
    );
    const pids = z.array(z.number()).parse(await readJson(record));
    expect(await proc.stop({ graceMs: 50 })).toMatchObject({ reason: "stopped" });
    await expect.poll(() => pids.filter(running)).toEqual([]);
  });

  test("a batch login entrypoint keeps every argument through cmd.exe", async () => {
    const root = await directory();
    const record = join(root, "argv.json");
    const command = join(root, "login shim.cmd");
    await writeFile(
      command,
      '@echo off\r\n"%ACE_NODE%" -e "require(\'node:fs\').writeFileSync(process.env.ACE_RECORD, JSON.stringify(process.argv.slice(1)))" %*\r\n',
    );
    const args = ["a&b", "%PATH%", "x^y", 'say "hi"', "C:\\my dir\\", "", "雪"];
    const proc = track(
      spawnInteractive({
        command,
        args,
        env: { ...process.env, ACE_NODE: process.execPath, ACE_RECORD: record },
      }),
    );
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    expect(await readJson(record)).toEqual(args);
  });

  test("a login CLI that cannot start reports a spawn error", async () => {
    const proc = track(
      spawnInteractive({ command: "ace-definitely-missing-login-binary", args: [], env: {} }),
    );
    expect(await proc.exited).toMatchObject({ reason: "spawn-error" });
  });
});
