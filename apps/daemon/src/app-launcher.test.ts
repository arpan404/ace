import { describe, expect, it } from "vitest";
import { launcherIsApp, linuxAppLauncher, windowsAppLauncher } from "./app-launcher.ts";

/** A file system whose paths are all root's and writable by root alone, but for `except`. */
function rootOwned(except: Record<string, { uid: number; mode: number } | undefined> = {}) {
  return (path: string) => (path in except ? except[path] : { uid: 0, mode: 0o40755 });
}

describe("a Linux launcher counts as the app only as the installed, root-owned app", () => {
  it("counts the deb's install", () => {
    expect(linuxAppLauncher("/opt/ace/ace-desktop", rootOwned())).toBe(true);
  });

  it.each([
    ["an AppImage mounted in the person's own temp", "/tmp/.mount_aceXYZ/ace-desktop"],
    ["a copy in the person's home", "/home/person/ace/ace-desktop"],
    ["another program in /opt", "/opt/ace/node"],
    ["a binary replaced since it started", "/opt/ace/ace-desktop (deleted)"],
    ["a path that isn't canonical", "/opt/ace/../ace/ace-desktop"],
    ["no executable at all", undefined],
  ])("doesn't count %s", (_what, exe) => {
    expect(linuxAppLauncher(exe, rootOwned())).toBe(false);
  });

  it("doesn't count an install the person could have written: owned by them", () => {
    const theirs = rootOwned({ "/opt/ace": { uid: 1000, mode: 0o40755 } });
    expect(linuxAppLauncher("/opt/ace/ace-desktop", theirs)).toBe(false);
  });

  it("doesn't count an install anyone may change: writable by its group or others", () => {
    const open = rootOwned({ "/opt/ace/ace-desktop": { uid: 0, mode: 0o100777 } });
    expect(linuxAppLauncher("/opt/ace/ace-desktop", open)).toBe(false);
  });
});

describe("a Windows launcher counts only with a valid signature by the pinned publisher", () => {
  const publisher = "CN=ace, O=ace, C=US";
  it("counts a valid signature by the publisher", () => {
    expect(windowsAppLauncher(`Valid\r\n${publisher}\r\n`, publisher)).toBe(true);
  });

  it.each([
    ["an invalid signature", `HashMismatch\r\n${publisher}`],
    ["another signer", "Valid\r\nCN=someone else"],
    ["no signature", "NotSigned\r\n"],
  ])("doesn't count %s", (_what, answer) => {
    expect(windowsAppLauncher(answer, publisher)).toBe(false);
  });

  it("counts nothing while no publisher is pinned, as today's builds are unsigned", async () => {
    expect(windowsAppLauncher(`Valid\r\n${publisher}`, undefined)).toBe(false);
    expect(await launcherIsApp(4242, "win32")).toBe(false);
  });
});

describe("the launcher of a test run", () => {
  it("is no app: this process's own parent isn't the signed ace app", async () => {
    expect(await launcherIsApp(process.ppid)).toBe(false);
  });
});
