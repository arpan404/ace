import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveScreenHelper } from "./screen-helper-path.ts";

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
