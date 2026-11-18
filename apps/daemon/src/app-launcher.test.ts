import { describe, expect, it } from "vitest";
import { launcherIsApp, windowsAppLauncher } from "./app-launcher.ts";

/** A macOS whose Security framework says the parent is the signed app. */
const signedParent = { codesign: async () => true };

describe("app standing on macOS waits for the daemon's code to ship sealed", () => {
  it("a packaged app whose daemon code sits beside the archive gets none, even from a signed parent", async () => {
    expect(await launcherIsApp(4242, "darwin", { ...signedParent, sealed: false })).toBe(false);
  });

  it("once a build seals the daemon's code, a signed parent counts and an unsigned one doesn't", async () => {
    expect(await launcherIsApp(4242, "darwin", { ...signedParent, sealed: true })).toBe(true);
    const unsigned = { sealed: true, codesign: async () => false };
    expect(await launcherIsApp(4242, "darwin", unsigned)).toBe(false);
  });
});

describe("on Linux the app key never grants standing", () => {
  it("whatever launched the daemon, the genuine installed app included", async () => {
    const everything = { sealed: true, codesign: async () => true };
    expect(await launcherIsApp(4242, "linux", everything)).toBe(false);
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
