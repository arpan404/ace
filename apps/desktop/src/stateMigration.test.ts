import os from "node:os";
import { mkdtempSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopBaseDir, resolveDesktopUserDataPath } from "./stateMigration";

describe("resolveDesktopBaseDir", () => {
  it("returns the .ace base dir", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-desktop-base-"));

    const resolved = resolveDesktopBaseDir({ homeDir: fakeHome });

    expect(resolved).toBe(path.join(fakeHome, ".ace"));
  });
});

describe("resolveDesktopUserDataPath", () => {
  it("returns the platform-specific ace profile dir", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-desktop-userdata-"));
    const appSupportDir = path.join(fakeHome, "Library", "Application Support");

    const resolved = resolveDesktopUserDataPath({
      platform: "darwin",
      userDataDirName: "ace",
      homeDir: fakeHome,
    });

    expect(resolved).toBe(path.join(appSupportDir, "ace"));
  });
});
