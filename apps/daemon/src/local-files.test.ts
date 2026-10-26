import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ace-data-dir-"));
  roots.push(path);
  return path;
}

test.skipIf(process.platform === "win32")(
  "an existing data directory other users can enter is restricted to its owner before locking",
  () => {
    const dataDir = join(root(), ".ace");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const release = acquireLock(dataDir);
    try {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      release();
    }
  },
);

test("a linked data directory is refused", () => {
  const base = root();
  const target = join(base, "elsewhere");
  mkdirSync(target, { mode: 0o700 });
  const dataDir = join(base, ".ace");
  // A junction on Windows, which needs no privilege; a symlink elsewhere.
  symlinkSync(target, dataDir, "junction");
  expect(() => acquireLock(dataDir)).toThrow("symbolic link");
});

test("a second daemon cannot take the data directory lock until the first releases it", () => {
  const dataDir = join(root(), ".ace");
  const release = acquireLock(dataDir);
  try {
    expect(() => acquireLock(dataDir)).toThrow("Another daemon owns it");
  } finally {
    release();
  }
  acquireLock(dataDir)();
});

test("the daemon token and host id are created once and keep their values across loads", () => {
  const dataDir = join(root(), ".ace");
  acquireLock(dataDir)();
  const token = loadToken(dataDir);
  const host = loadHostId(dataDir);
  expect(token.token).toMatch(/^[0-9a-f]{64}$/);
  expect(host).toMatch(/^[0-9a-f-]{36}$/);
  expect(loadToken(dataDir)).toEqual(token);
  expect(loadHostId(dataDir)).toBe(host);
});
