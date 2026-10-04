import { describe, expect, it } from "vitest";
import { desktopFolders } from "./desktop-folders.ts";

function bridge(answers: { chosen?: unknown; path?: unknown; source?: string }) {
  return {
    ace: {
      dialogs: { openFolder: async () => answers.chosen ?? null },
      files: { pathForFile: () => answers.path ?? "" },
      daemon: { status: async () => ({ source: answers.source ?? "app" }) },
    },
  };
}

describe("desktop folders", () => {
  it("is absent in a browser, where the daemon's folder browser picks folders", () => {
    expect(desktopFolders({})).toBeUndefined();
    expect(desktopFolders({ ace: { daemon: {} } })).toBeUndefined();
  });

  it("hands back the folder chosen natively and nothing that isn't an absolute path", async () => {
    await expect(desktopFolders(bridge({ chosen: "/Users/me/app" }))?.choose()).resolves.toBe(
      "/Users/me/app",
    );
    await expect(desktopFolders(bridge({ chosen: "app" }))?.choose()).resolves.toBeNull();
    await expect(desktopFolders(bridge({}))?.choose()).resolves.toBeNull();
  });

  it("reads a dropped folder's path only when the bridge has one", () => {
    const file = new File([], "app");
    expect(desktopFolders(bridge({ path: "/Users/me/app" }))?.pathOf(file)).toBe("/Users/me/app");
    expect(desktopFolders(bridge({ path: "" }))?.pathOf(file)).toBeNull();
  });

  it("knows a remote daemon's folders aren't this computer's", async () => {
    await expect(desktopFolders(bridge({ source: "remote" }))?.local()).resolves.toBe(false);
    await expect(desktopFolders(bridge({ source: "service" }))?.local()).resolves.toBe(true);
  });
});
