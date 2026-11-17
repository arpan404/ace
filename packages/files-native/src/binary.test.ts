import { describe, expect, it } from "vitest";
import { filesBinaryName, filesBinaryPath } from "./binary.ts";

const exists = (paths: string[]) => (path: string) => paths.includes(path);
const fromSource = (paths: string[], env: Record<string, string> = {}) =>
  filesBinaryPath({
    mode: "development",
    env,
    sourceRoot: "/src",
    platform: "linux",
    exists: exists(paths),
  });

describe("filesBinaryPath", () => {
  it("runs only the bundled binary in a release, whatever ACE_FILES_PATH says", () => {
    const original = process.env.ACE_FILES_PATH;
    process.env.ACE_FILES_PATH = "/tmp/evil";
    try {
      expect(
        filesBinaryPath({
          mode: "release",
          entry: "/rel/ace.mjs",
          platform: "linux",
          exists: exists(["/rel/files/ace-files"]),
        }),
      ).toBe("/rel/files/ace-files");
    } finally {
      if (original === undefined) delete process.env.ACE_FILES_PATH;
      else process.env.ACE_FILES_PATH = original;
    }
  });

  it("finds the desktop bundle's files folder and names the executable for Windows", () => {
    expect(filesBinaryName("win32")).toBe("ace-files.exe");
    expect(
      filesBinaryPath({
        mode: "release",
        entry: "/App/Resources/daemon/ace.mjs",
        platform: "win32",
        exists: (path) =>
          path === "/App/Resources/files/ace-files.exe" ||
          path.endsWith("/daemon/desktop-app.json"),
      }),
    ).toBe("/App/Resources/files/ace-files.exe");
    expect(
      filesBinaryPath({
        mode: "release",
        entry: "/rel/ace.mjs",
        platform: "darwin",
        exists: exists([]),
      }),
    ).toBeUndefined();
  });

  it("honours ACE_FILES_PATH, then the source tree's release and debug builds", () => {
    const release = "/src/native/files/target/release/ace-files";
    const debug = "/src/native/files/target/debug/ace-files";
    expect(fromSource([release], { ACE_FILES_PATH: " /x/ace-files " })).toBe("/x/ace-files");
    expect(fromSource([release, debug])).toBe(release);
    expect(fromSource([debug])).toBe(debug);
    expect(fromSource([])).toBeUndefined();
    expect(
      filesBinaryPath({
        mode: "development",
        env: {},
        sourceRoot: undefined,
        platform: "linux",
        exists: exists([release]),
      }),
    ).toBeUndefined();
  });
});
