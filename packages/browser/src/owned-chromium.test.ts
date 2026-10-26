import { expect, test } from "vitest";
import { ownedChromium } from "./owned-chromium.ts";

test("Windows ARM64 uses an installed browser without requesting an unavailable download", async () => {
  expect(
    await ownedChromium("win32", "arm64", {
      installed: async () => "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      acquire: async () => {
        throw new Error("No Windows ARM64 artifact");
      },
    }),
  ).toBe("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
});

test("Windows ARM64 reports the missing installed browser instead of attempting acquisition", async () => {
  await expect(
    ownedChromium("win32", "arm64", {
      installed: async () => undefined,
      acquire: async () => "unavailable-download",
    }),
  ).rejects.toThrow("Install Chrome or Microsoft Edge");
});

test.each([
  ["win32", "x64"],
  ["darwin", "arm64"],
  ["linux", "arm64"],
] as const)("%s %s retains pinned browser acquisition", async (platform, arch) => {
  expect(
    await ownedChromium(platform, arch, {
      installed: async () => "user-browser",
      acquire: async () => "verified-pinned-browser",
    }),
  ).toBe("verified-pinned-browser");
});
