import { expect, test } from "vitest";
import { discoverCursorSdk } from "./host.ts";

// The installed @cursor/sdk and its platform helper, as `bun install --os=win32` lays them out.
const windows = process.platform === "win32";

test.runIf(windows && process.arch === "x64")(
  "Windows x64 admits the installed Cursor SDK with its rg.exe helper",
  async () => {
    expect(await discoverCursorSdk()).toMatchObject({
      installed: true,
      supported: true,
      version: "1.0.35",
    });
  },
);

test.runIf(windows && process.arch === "arm64")(
  "Windows ARM64 refuses Cursor and says its SDK has no ARM64 build",
  async () => {
    const admission = await discoverCursorSdk();
    expect(admission).toMatchObject({ installed: true, supported: false, version: "1.0.35" });
    expect(admission.error).toBe(
      "Cursor's SDK has no Windows ARM64 build, so Cursor can't run on this PC",
    );
  },
);

test.runIf(windows)("a Windows x64 SDK without its helper package is refused by name", async () => {
  const admission = await discoverCursorSdk({
    arch: "x64",
    resolve: (id) => {
      if (id === "@cursor/sdk") return "C:\\sdk\\dist\\esm\\index.js";
      throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
    },
    read: async () => '{"name":"@cursor/sdk","version":"1.0.35"}',
  });
  expect(admission).toMatchObject({ installed: true, supported: false });
  expect(admission.error).toBe(
    "Cursor's Windows helper @cursor/sdk-win32-x64 is missing; reinstall ace",
  );
});
