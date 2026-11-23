import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startableDaemonRuntime } from "./daemon-program.ts";
import { bundledDaemonRuntime, scriptRuntimePath, shippedExecutableName } from "./process-names.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const appFiles = (path: string) =>
  path === "/App/Contents/Resources/runtime/bin/ace Service" ||
  path === "/App/Contents/Resources/runtime/bin/node";
const releaseFiles = (path: string) => path === "/rel/bin/node.exe";
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-process-names-"));
  roots.push(root);
  return root;
}

test("services ship titled on macOS and Windows and hyphenated on Linux", () => {
  expect(shippedExecutableName("media", "darwin")).toBe("ace Media Service");
  expect(shippedExecutableName("files", "win32")).toBe("ace Files Service.exe");
  expect(shippedExecutableName("history", "linux")).toBe("ace-history-service");
  expect(shippedExecutableName("daemon", "darwin")).toBe("ace Service");
  expect(shippedExecutableName("daemon", "win32")).toBe("ace Service.exe");
  expect(shippedExecutableName("daemon", "linux")).toBe("ace-service");
});

test("the desktop app starts its daemon on the runtime copy named for it when it ships one", () => {
  expect(bundledDaemonRuntime("/App/Contents/Resources/runtime/bin/node", "darwin", appFiles)).toBe(
    "/App/Contents/Resources/runtime/bin/ace Service",
  );
  // A bundle from before the rename carries only the runtime.
  expect(bundledDaemonRuntime("/Old/runtime/bin/node", "darwin", () => false)).toBe(
    "/Old/runtime/bin/node",
  );
});

test("the daemon's child scripts run on the plain runtime beside it, never as the service", () => {
  expect(scriptRuntimePath("/rel/bin/ace Service.exe", "win32", releaseFiles)).toBe(
    "/rel/bin/node.exe",
  );
  expect(scriptRuntimePath("/rel/bin/node", "linux", releaseFiles)).toBe("/rel/bin/node");
  // Without the plain runtime beside it the daemon keeps what it has.
  expect(scriptRuntimePath("/x/ace-service", "linux", () => false)).toBe("/x/ace-service");
});

test("a standalone release links its runtime under the daemon's name once, sharing its bytes", () => {
  const release = join(scratch(), "releases", "1.2.3-darwin-arm64");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "release.json"), "{}");
  const runtime = join(release, "bin", "node");
  writeFileSync(runtime, "runtime bytes");
  const named = join(release, "bin", shippedExecutableName("daemon", process.platform));

  expect(startableDaemonRuntime(runtime, process.platform)).toBe(named);
  expect(statSync(named).ino).toBe(statSync(runtime).ino);
  expect(readFileSync(named, "utf8")).toBe("runtime bytes");
  // The next start reuses it.
  expect(startableDaemonRuntime(runtime, process.platform)).toBe(named);
});

test("outside a release ace installed nothing is written and the daemon runs on the runtime", () => {
  // A Homebrew keg carries a release's files, release.json included, but is not ace's to add to.
  const keg = join(scratch(), "Cellar", "ace", "1.2.3", "libexec");
  mkdirSync(join(keg, "bin"), { recursive: true });
  writeFileSync(join(keg, "release.json"), "{}");
  const runtime = join(keg, "bin", "node");
  writeFileSync(runtime, "runtime bytes");

  expect(startableDaemonRuntime(runtime, process.platform)).toBe(runtime);
  expect(() =>
    statSync(join(keg, "bin", shippedExecutableName("daemon", process.platform))),
  ).toThrow();
});
