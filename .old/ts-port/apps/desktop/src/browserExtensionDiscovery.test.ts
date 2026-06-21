import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBrowserExtensionDirectories } from "./browserExtensionDiscovery";

function createFakeFs(paths: ReadonlyMap<string, readonly string[]>) {
  return {
    existsSync: (path: string) => paths.has(path) || path.endsWith("manifest.json"),
    readdirSync: ((path: string, options?: unknown) => {
      const names = paths.get(path) ?? [];
      if (
        typeof options === "object" &&
        options !== null &&
        "withFileTypes" in options &&
        options.withFileTypes === true
      ) {
        return names.map((name) => ({
          isDirectory: () => !name.endsWith(".json"),
          name,
        }));
      }
      return [...names];
    }) as typeof import("node:fs").readdirSync,
    statSync: ((path: string) => {
      const version = Number(path.split(Path.sep).at(-1)?.replaceAll(".", "") ?? "0");
      return { mtimeMs: Number.isFinite(version) ? version : 0 };
    }) as typeof import("node:fs").statSync,
  };
}

describe("browserExtensionDiscovery", () => {
  it("includes explicit extension directories from the environment first", () => {
    const explicit = Path.join(Path.sep, "extensions", "bitwarden");
    const fs = createFakeFs(new Map([[explicit, []]]));

    expect(
      resolveBrowserExtensionDirectories({
        env: { ACE_DESKTOP_BROWSER_EXTENSION_DIRS: explicit },
        existsSync: fs.existsSync,
        homeDir: Path.join(Path.sep, "Users", "ace"),
        platform: "darwin",
        readdirSync: fs.readdirSync,
        statSync: fs.statSync,
      }),
    ).toEqual([explicit]);
  });

  it("discovers known password manager extensions from Chromium profiles", () => {
    const homeDir = Path.join(Path.sep, "Users", "ace");
    const profileRoot = Path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
    const extensionRoot = Path.join(
      profileRoot,
      "Default",
      "Extensions",
      "nngceckbapebfimnlniiiahkandclblb",
    );
    const fs = createFakeFs(
      new Map([
        [profileRoot, ["Default", "System Profile"]],
        [extensionRoot, ["2025.12.0", "2026.1.0"]],
      ]),
    );

    expect(
      resolveBrowserExtensionDirectories({
        env: {},
        existsSync: fs.existsSync,
        homeDir,
        platform: "darwin",
        readdirSync: fs.readdirSync,
        statSync: fs.statSync,
      }),
    ).toEqual([Path.join(extensionRoot, "2026.1.0")]);
  });
});
