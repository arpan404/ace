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
  const release = scratch();
  mkdirSync(join(release, "bin"));
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

test("outside a standalone release nothing is written and the daemon runs on the runtime", () => {
  const resources = scratch();
  mkdirSync(join(resources, "bin"));
  const runtime = join(resources, "bin", "node");
  writeFileSync(runtime, "runtime bytes");

  expect(startableDaemonRuntime(runtime, process.platform)).toBe(runtime);
  expect(() =>
    statSync(join(resources, "bin", shippedExecutableName("daemon", process.platform))),
  ).toThrow();
});
