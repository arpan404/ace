import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acquireLock } from "./local-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

test.skipIf(process.platform === "win32")("a symlinked data directory is refused", () => {
  const base = root();
  const target = join(base, "elsewhere");
  mkdirSync(target, { mode: 0o700 });
  const dataDir = join(base, ".ace");
  symlinkSync(target, dataDir);
  expect(() => acquireLock(dataDir)).toThrow("symbolic link");
});
