import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { spawnSupervised } from "./process.ts";
import { spawnBytes } from "./process-bytes.ts";

const win = test.runIf(process.platform === "win32");

win(
  "native Windows supervision preserves final output and exit status",
  async ({ onTestFinished }) => {
    const proc = spawnSupervised({
      command: process.execPath,
      args: ["-e", "console.log('final Windows output'); process.exitCode = 23"],
      env: {},
      name: "windows-native-exit",
    });
    onTestFinished(async () => {
      await proc.stop({ graceMs: 0 });
    });
    const lines: string[] = [];
    proc.stdout.on("line", (line) => lines.push(line));
    expect(await proc.exited).toEqual({ code: 23, signal: null, reason: "exit" });
    expect(lines).toEqual(["final Windows output"]);
  },
);

win(
  "a real Windows batch shim preserves arguments through cmd parsing",
  async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "ace-native-batch-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const record = join(root, "argv.json");
    const command = join(root, "agent shim.cmd");
    await writeFile(
      command,
      '@echo off\r\n"%ACE_NODE%" -e "require(\'node:fs\').writeFileSync(process.env.ACE_RECORD, JSON.stringify(process.argv.slice(1)))" %*\r\n',
    );
    const args = ["a&b", "%PATH%", "two words", "雪"];
    const proc = spawnSupervised({
      command,
      args,
      env: { ACE_NODE: process.execPath, ACE_RECORD: record },
      cwd: root,
      name: "windows-native-batch",
    });
    onTestFinished(async () => {
      await proc.stop({ graceMs: 0 });
    });
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    expect(z.array(z.string()).parse(JSON.parse(await readFile(record, "utf8")))).toEqual(args);
  },
);

win("stopping a real Windows byte process ends a running child", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "ace-native-byte-stop-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const proc = spawnBytes({
    command: process.execPath,
    args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    cwd: root,
    env: { ...process.env },
  });
  onTestFinished(() => proc.stop());
  await once(proc.stdout, "data");
  await proc.stop();
  expect(await proc.exited).toBe(1);
});
