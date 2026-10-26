import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChromium, installedWindowsChromium } from "./discovery.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function fakeExecutable(directory: string, ...segments: string[]): Promise<string> {
  const path = join(directory, ...segments);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "fake browser");
  return path;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-discovery-win-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("Windows Chromium detection", () => {
  it("prefers the explicit executablePath override on Windows", async () => {
    const root = await tempRoot();
    const explicit = await fakeExecutable(root, "custom", "chrome.exe");
    expect(await detectChromium({ platform: "win32", env: {}, executablePath: explicit })).toBe(
      explicit,
    );
  });

  it("prefers ACE_CHROMIUM_PATH and skips a missing override", async () => {
    const root = await tempRoot();
    const override = await fakeExecutable(root, "override", "chrome.exe");
    expect(await detectChromium({ platform: "win32", env: { ACE_CHROMIUM_PATH: override } })).toBe(
      override,
    );
    expect(
      await detectChromium({
        platform: "win32",
        env: { ACE_CHROMIUM_PATH: join(root, "missing", "chrome.exe") },
      }),
    ).toBeUndefined();
  });

  it("detects installed Edge on Windows when Chrome is absent", async () => {
    const root = await tempRoot();
    const edge = await fakeExecutable(root, "Microsoft", "Edge", "Application", "msedge.exe");
    expect(await detectChromium({ platform: "win32", env: { LOCALAPPDATA: root } })).toBe(edge);
  });

  it("prefers installed Chrome over installed Edge on Windows", async () => {
    const root = await tempRoot();
    await fakeExecutable(root, "Microsoft", "Edge", "Application", "msedge.exe");
    const chrome = await fakeExecutable(root, "Google", "Chrome", "Application", "chrome.exe");
    expect(await detectChromium({ platform: "win32", env: { LOCALAPPDATA: root } })).toBe(chrome);
  });

  it("finds msedge.exe on a Windows PATH", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    const edge = await fakeExecutable(bin, "msedge.exe");
    expect(await detectChromium({ platform: "win32", env: { PATH: bin } })).toBe(edge);
  });

  it("rejects a Windows batch wrapper without a real executable", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await fakeExecutable(bin, "msedge.bat");
    expect(await detectChromium({ platform: "win32", env: { PATH: bin } })).toBeUndefined();
  });
});

describe("Windows ARM64 browser", () => {
  it("uses the installed browser, since no pinned download exists", async () => {
    const root = await tempRoot();
    const edge = await fakeExecutable(root, "Microsoft", "Edge", "Application", "msedge.exe");
    expect(await installedWindowsChromium({ env: { LOCALAPPDATA: root } })).toBe(edge);
  });

  it("asks for Chrome or Edge when neither is installed", async () => {
    await expect(installedWindowsChromium({ env: {} })).rejects.toThrow(
      "Install Chrome or Microsoft Edge",
    );
  });
});
