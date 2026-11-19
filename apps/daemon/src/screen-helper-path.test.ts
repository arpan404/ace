import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScreenHelper } from "@ace/screen";
import { afterEach, expect, test } from "vitest";
import { resolveScreenHelper, screenHelperExecutable } from "./screen-helper-path.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle(withHelper: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "ace-bundle-"));
  roots.push(root);
  if (withHelper) {
    mkdirSync(join(root, "helpers"));
    writeFileSync(join(root, "helpers", "ace-screen-helper-linux"), "");
  }
  return root;
}

test("a Linux daemon without ACE_SCREEN_HELPER runs the helper staged beside its bundle", () => {
  const root = bundle(true);
  expect(
    resolveScreenHelper({
      platform: "linux",
      configured: undefined,
      bundleDirectory: root,
      exists: existsSync,
    }),
  ).toBe(join(root, "helpers", "ace-screen-helper-linux"));
});

test("ACE_SCREEN_HELPER wins over a staged Linux helper", () => {
  expect(
    resolveScreenHelper({
      platform: "linux",
      configured: "/opt/ace/ace-screen-helper-linux",
      bundleDirectory: bundle(true),
      exists: existsSync,
    }),
  ).toBe("/opt/ace/ace-screen-helper-linux");
});

test("a Linux daemon with no configured or staged helper offers no screen helper", () => {
  expect(
    resolveScreenHelper({
      platform: "linux",
      configured: undefined,
      bundleDirectory: bundle(false),
      exists: existsSync,
    }),
  ).toBeUndefined();
});

test("a Mac daemon never picks up a Linux helper beside its bundle", () => {
  expect(
    resolveScreenHelper({
      platform: "darwin",
      configured: undefined,
      bundleDirectory: bundle(true),
      exists: existsSync,
    }),
  ).toBeUndefined();
});

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A helper `.app` whose executable prints "helper ran", with its manifest beside it. */
function helperApp(): { app: string; manifest: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ace-helper-app-"));
  roots.push(root);
  const app = join(root, "AceScreenHelper.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const executable = join(app, "Contents", "MacOS", "ace-screen-helper");
  writeFileSync(executable, "#!/bin/sh\necho helper ran\n");
  chmodSync(executable, 0o755);
  const plist = join(app, "Contents", "Info.plist");
  writeFileSync(plist, "<plist/>");
  const manifest = join(root, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      bundleId: "dev.ace.screen-helper",
      sha256: sha256(executable),
      plistSha256: sha256(plist),
    }),
  );
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  return { app, manifest, dataDir };
}

test.skipIf(process.platform === "win32")(
  "a helper named by its .app bundle resolves to an executable that starts",
  async () => {
    const { app, manifest, dataDir } = helperApp();
    const executable = await screenHelperExecutable(`${app}/`, (path) =>
      installScreenHelper(path, dataDir, manifest),
    );
    expect(execFileSync(executable, { encoding: "utf8" })).toBe("helper ran\n");
  },
);

test("a helper named by its executable is started as named, never installed", async () => {
  const executable = await screenHelperExecutable("/opt/ace/ace-screen-helper", () =>
    Promise.reject(new Error("installed")),
  );
  expect(executable).toBe("/opt/ace/ace-screen-helper");
});
