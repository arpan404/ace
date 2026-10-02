import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import { fingerprint, keyPair } from "./index.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "ace-key-boundary-"));
  directories.push(dir);
  return dir;
}

it("a FIFO identity fails without waiting for a writer", async () => {
  const dir = await directory();
  await promisify(execFile)("mkfifo", ["-m", "600", join(dir, "noise-static.key")]);
  const entry = new URL("./node.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { loadOrCreateHostKeys } from ${JSON.stringify(entry)};
     try { await loadOrCreateHostKeys(${JSON.stringify(dir)}); }
     catch (error) { console.error(error.message); process.exitCode = 1; }`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => {
    error += chunk.toString();
  });
  const exited = once(child, "close");
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const [code, signal] = await exited;
    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(error).toContain("regular file");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await exited;
  }
}, 15000);

it.each([0, 31, 33, 64 * 1024 * 1024])(
  "a %i-byte identity is rejected without rotating the file",
  async (size) => {
    const dir = await directory();
    const path = join(dir, "noise-static.key");
    const file = await open(path, "wx", 0o600);
    try {
      await file.truncate(size);
    } finally {
      await file.close();
    }
    await expect(loadOrCreateHostKeys(dir)).rejects.toThrow("Invalid stored static key");
    const stored = await open(path, "r");
    try {
      expect((await stored.stat()).size).toBe(size);
    } finally {
      await stored.close();
    }
  },
);

it.skipIf(process.getuid?.() === 0)(
  "an existing identity restarts from a directory without write permission",
  async () => {
    const dir = await directory();
    const keys = keyPair();
    await writeFile(join(dir, "noise-static.key"), keys.privateKey, { mode: 0o600 });
    await chmod(dir, 0o500);
    const loaded = await loadOrCreateHostKeys(dir);
    expect(fingerprint(loaded.publicKey)).toBe(fingerprint(keys.publicKey));
  },
);
