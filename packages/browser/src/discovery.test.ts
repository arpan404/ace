import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChromium, ownedChromium } from "./discovery.ts";

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

describe("Chromium detection", () => {
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

  it("keeps POSIX PATH order: chromium before google-chrome", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    const first = await fakeExecutable(bin, "chromium");
    await fakeExecutable(bin, "google-chrome");
    await chmod(first, 0o755);
    await chmod(join(bin, "google-chrome"), 0o755);
    expect(await detectChromium({ platform: "linux", env: { PATH: bin } })).toBe(first);
  });
});

describe("ace's own browser executable", () => {
  it("uses an installed browser on Windows ARM64 without requesting an unavailable download", async () => {
    expect(
      await ownedChromium("win32", "arm64", {
        installed: async () => "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        acquire: async () => {
          throw new Error("No Windows ARM64 artifact");
        },
      }),
    ).toBe("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  it("reports a missing installed browser on Windows ARM64 instead of attempting acquisition", async () => {
    await expect(
      ownedChromium("win32", "arm64", {
        installed: async () => undefined,
        acquire: async () => "unavailable-download",
      }),
    ).rejects.toThrow("Install Chrome or Microsoft Edge");
  });

  it.each([
    ["win32", "x64"],
    ["darwin", "arm64"],
    ["linux", "arm64"],
  ] as const)("%s %s keeps the pinned download", async (platform, arch) => {
    expect(
      await ownedChromium(platform, arch, {
        installed: async () => "user-browser",
        acquire: async () => "verified-pinned-browser",
      }),
    ).toBe("verified-pinned-browser");
  });
});
