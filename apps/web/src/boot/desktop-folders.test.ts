import { describe, expect, it } from "vitest";
import { desktopFolders } from "./desktop-folders.ts";

function bridge(answers: { chosen?: unknown; path?: unknown; source?: string }) {
  return {
    ace: {
      dialogs: { openFolder: async () => answers.chosen ?? null },
      files: { pathForFile: () => answers.path ?? "" },
      daemon: {
        status: async () => ({ state: "running", source: answers.source ?? "app" }),
        connection: async () => ({
          mode: "daemon",
          url: "ws://127.0.0.1:4242/",
          token: "a".repeat(64),
        }),
      },
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
    await expect(
      desktopFolders(bridge({ source: "remote" }))?.local({
        url: "ws://127.0.0.1:4242/",
        token: "a".repeat(64),
      }),
    ).resolves.toBe(false);
    await expect(
      desktopFolders(bridge({ source: "service" }))?.local({
        url: "ws://127.0.0.1:4242/",
        token: "a".repeat(64),
      }),
    ).resolves.toBe(true);
  });
});

it("rejects local paths after the renderer switches away from its local supervisor", async () => {
  const local = { url: "ws://127.0.0.1:4242/", token: "a".repeat(64) };
  const scope = bridge({ source: "app", chosen: "/Users/me/app", path: "/Users/me/app" });
  Object.assign(scope.ace.daemon, { connection: async () => ({ mode: "daemon", ...local }) });
  const picker = desktopFolders(scope);
  await expect(picker?.local({ url: "wss://remote.example/", token: local.token })).resolves.toBe(
    false,
  );
  await expect(picker?.local(local)).resolves.toBe(true);
  await expect(picker?.local()).resolves.toBe(false);
});

it("fails closed when the desktop cannot identify its current local daemon", async () => {
  const scope = bridge({ source: "app" });
  Object.assign(scope.ace.daemon, {
    connection: async () => {
      throw new Error("starting");
    },
  });
  await expect(
    desktopFolders(scope)?.local({ url: "ws://127.0.0.1:4242/", token: "a".repeat(64) }),
  ).resolves.toBe(false);
});
