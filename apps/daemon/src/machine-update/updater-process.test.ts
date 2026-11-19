import { expect, test } from "vitest";
import { detectInstall } from "./updater-process.ts";

test.each([
  [
    "the desktop app's bundled daemon",
    "/Applications/ace.app/Contents/Resources/daemon/ace.mjs",
    ["/Applications/ace.app/Contents/Resources/daemon/desktop-app.json"],
    "desktop",
  ],
  [
    "an AppImage's bundled daemon",
    "/tmp/.mount_ace/resources/daemon/ace.mjs",
    ["/tmp/.mount_ace/resources/daemon/desktop-app.json"],
    "desktop",
  ],
  [
    "a release install.sh put in place",
    "/home/me/.ace/releases/0.0.18-linux-x64/ace.mjs",
    [],
    "standalone",
  ],
  ["a checkout", "/home/me/code/ace/apps/daemon/src/cli/main.ts", [], "source"],
  ["no entry script", undefined, [], "source"],
] as const)("%s is told apart by its entry script", (_name, entry, present, install) => {
  expect(detectInstall(entry, (path) => (present as readonly string[]).includes(path))).toBe(
    install,
  );
});
