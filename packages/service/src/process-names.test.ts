import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startableDaemonRuntime } from "./daemon-program.ts";
import { desktopAppMarker } from "./desktop-update.ts";
import { scriptRuntimeName, scriptRuntimePath, shippedExecutableName } from "./process-names.ts";

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-process-names-"));
  roots.push(root);
  return root;
}
function runnable(path: string, bytes: string): string {
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  return path;
}
/** `<root>/releases/<release>/bin/node` beside its release.json, as ace installs one. */
function installedRelease(): { runtime: string; named: string } {
  const release = join(scratch(), "releases", "1.2.3-test");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "release.json"), "{}");
  return {
    runtime: runnable(join(release, "bin", scriptRuntimeName(platform)), "runtime bytes"),
    named: join(release, "bin", shippedExecutableName("daemon", platform)),
  };
}
/** The desktop app's resources: the runtime folder and the daemon's app marker. */
function desktopResources(): { runtime: string; named: string } {
  const resources = scratch();
  const folder =
    platform === "win32" ? join(resources, "runtime") : join(resources, "runtime", "bin");
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(resources, "daemon"));
  writeFileSync(join(resources, "daemon", desktopAppMarker), "{}");
  return {
    runtime: runnable(join(folder, scriptRuntimeName(platform)), "runtime bytes"),
    named: join(folder, shippedExecutableName("daemon", platform)),
  };
}
const sameFile = (a: string, b: string) => statSync(a).ino === statSync(b).ino;

test("services ship titled on macOS and Windows and hyphenated on Linux", () => {
  expect(shippedExecutableName("media", "darwin")).toBe("ace Media Service");
  expect(shippedExecutableName("files", "win32")).toBe("ace Files Service.exe");
  expect(shippedExecutableName("history", "linux")).toBe("ace-history-service");
  expect(shippedExecutableName("daemon", "darwin")).toBe("ace Service");
  expect(shippedExecutableName("daemon", "win32")).toBe("ace Service.exe");
  expect(shippedExecutableName("daemon", "linux")).toBe("ace-service");
});

test("the daemon's child scripts run on the plain runtime beside it, never as the service", () => {
  const bin = join(scratch(), "bin");
  const plain = join(bin, "node.exe");
  const present = (path: string) => path === plain;
  expect(scriptRuntimePath(join(bin, "ace Service.exe"), "win32", present)).toBe(plain);
  expect(scriptRuntimePath(join(bin, "node"), "linux", present)).toBe(join(bin, "node"));
  // Without the plain runtime beside it the daemon keeps what it has.
  const alone = join(bin, "ace-service");
  expect(scriptRuntimePath(alone, "linux", () => false)).toBe(alone);
});

test("the desktop app starts its daemon on the runtime copy it ships under the daemon's name", () => {
  const { runtime, named } = desktopResources();
  expect(startableDaemonRuntime(runtime, platform)).toBe(runtime);
  runnable(named, "signed copy");
  expect(startableDaemonRuntime(runtime, platform)).toBe(named);
});

test.skipIf(platform === "win32")(
  "a desktop copy that cannot run, or is no file, leaves the daemon on the runtime",
  () => {
    const { runtime, named } = desktopResources();
    writeFileSync(named, "not runnable");
    chmodSync(named, 0o644);
    expect(startableDaemonRuntime(runtime, platform)).toBe(runtime);
    rmSync(named);
    mkdirSync(named);
    expect(startableDaemonRuntime(runtime, platform)).toBe(runtime);
  },
);

test("a standalone release links its runtime under the daemon's name once, sharing its bytes", () => {
  const { runtime, named } = installedRelease();
  expect(startableDaemonRuntime(runtime, platform)).toBe(named);
  expect(sameFile(named, runtime)).toBe(true);
  expect(readFileSync(named, "utf8")).toBe("runtime bytes");
  // The next start reuses it.
  expect(startableDaemonRuntime(runtime, platform)).toBe(named);
});

test("a stale file under the daemon's name is relinked to this release's runtime", () => {
  const { runtime, named } = installedRelease();
  runnable(named, "some other build");
  expect(startableDaemonRuntime(runtime, platform)).toBe(named);
  expect(sameFile(named, runtime)).toBe(true);
  expect(readFileSync(named, "utf8")).toBe("runtime bytes");
});

test("a folder under the daemon's name is left alone and the daemon runs on the runtime", () => {
  const { runtime, named } = installedRelease();
  mkdirSync(named);
  writeFileSync(join(named, "kept"), "");
  expect(startableDaemonRuntime(runtime, platform)).toBe(runtime);
  expect(readFileSync(join(named, "kept"), "utf8")).toBe("");
});

test("outside a release ace installed nothing is written and the daemon runs on the runtime", () => {
  // A Homebrew keg carries a release's files, release.json included, but is not ace's to add to.
  const keg = join(scratch(), "Cellar", "ace", "1.2.3", "libexec");
  mkdirSync(join(keg, "bin"), { recursive: true });
  writeFileSync(join(keg, "release.json"), "{}");
  const runtime = runnable(join(keg, "bin", scriptRuntimeName(platform)), "runtime bytes");

  expect(startableDaemonRuntime(runtime, platform)).toBe(runtime);
  expect(() => statSync(join(keg, "bin", shippedExecutableName("daemon", platform)))).toThrow();
});
