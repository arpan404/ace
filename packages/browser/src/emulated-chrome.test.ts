import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { emulatedChromeArgs, emulatedChromeFlag, executableMachine } from "./emulated-chrome.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A minimal PE header for `machine`, the way a Windows executable begins. */
async function executable(machine: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-pe-"));
  cleanups.push(dir);
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  const path = join(dir, "chrome.exe");
  await writeFile(path, bytes);
  return path;
}

const windows = it.runIf(process.platform === "win32");

windows("Windows: an x64 Chrome on ARM64 runs with renderer code integrity off, once", async () => {
  const x64 = await executable(0x8664);
  const args = emulatedChromeArgs(x64, ["--headless=new"], "arm64");
  expect(args).toEqual(["--headless=new", emulatedChromeFlag]);
  // Started again (a crash restart, a retried first use): the flag is not added twice.
  expect(emulatedChromeArgs(x64, args, "arm64")).toEqual(args);
});

windows("Windows: a native ARM64 Chrome, and any Chrome on x64, keep the guard", async () => {
  const arm64 = await executable(0xaa64);
  const x64 = await executable(0x8664);
  expect(emulatedChromeArgs(arm64, ["--headless=new"], "arm64")).toEqual(["--headless=new"]);
  expect(emulatedChromeArgs(x64, ["--headless=new"], "x64")).toEqual(["--headless=new"]);
  expect(executableMachine(join(tmpdir(), "no-such-chrome.exe"))).toBeUndefined();
});
