import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webhookKeyName, webhookSecrets } from "./automation-webhook-key.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "ace-webhook-key-"));
  dirs.push(dir);
  return dir;
}
const posix = process.platform !== "win32";

describe("the webhook key file", () => {
  it("opening a secret never makes a key, so a lost key can't be silently replaced", () => {
    const dir = dataDir();
    const sealed = webhookSecrets(dataDir()).seal("whsec_x", "a");
    expect(webhookSecrets(dir).open(sealed, "a")).toBeUndefined();
    expect(existsSync(join(dir, webhookKeyName))).toBe(false);
  });

  it("the first secret makes an owner-only key both stores then share", () => {
    const dir = dataDir();
    const sealed = webhookSecrets(dir).seal("whsec_x", "a");
    if (posix) expect(statSync(join(dir, webhookKeyName)).mode & 0o777).toBe(0o600);
    expect(webhookSecrets(dir).open(sealed, "a")).toBe("whsec_x");
  });

  it.runIf(posix)("a key others can read is refused and left as it is", () => {
    const dir = dataDir();
    const sealed = webhookSecrets(dir).seal("whsec_x", "a");
    const path = join(dir, webhookKeyName);
    const before = readFileSync(path);
    chmodSync(path, 0o644);
    expect(webhookSecrets(dir).open(sealed, "a")).toBeUndefined();
    expect(() => webhookSecrets(dir).seal("whsec_y", "b")).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it.runIf(posix)("a key reached through a symlink is refused", () => {
    const dir = dataDir();
    const elsewhere = dataDir();
    const sealed = webhookSecrets(elsewhere).seal("whsec_x", "a");
    symlinkSync(join(elsewhere, webhookKeyName), join(dir, webhookKeyName));
    expect(webhookSecrets(dir).open(sealed, "a")).toBeUndefined();
    expect(() => webhookSecrets(dir).seal("whsec_y", "b")).toThrow();
  });

  it("a key of the wrong size is refused, not replaced", () => {
    const dir = dataDir();
    const path = join(dir, webhookKeyName);
    writeFileSync(path, Buffer.alloc(16), { mode: 0o600 });
    expect(() => webhookSecrets(dir).seal("whsec_x", "a")).toThrow();
    expect(readFileSync(path).length).toBe(16);
  });
});

describe("a key path that isn't a file", () => {
  it.runIf(posix)("a FIFO at the key's path is refused at once instead of blocking", () => {
    const dir = dataDir();
    execFileSync("mkfifo", [join(dir, webhookKeyName)]);
    // In a child process, so a blocking open fails the test by timeout, not by hanging it.
    const script = `
      const { webhookSecrets } = await import(${JSON.stringify(join(import.meta.dirname, "automation-webhook-key.ts"))});
      const box = webhookSecrets(${JSON.stringify(dir)});
      let sealed = "refused";
      try { box.seal("whsec_x", "a"); sealed = "made"; } catch {}
      console.log(JSON.stringify({ opened: box.open("v1.a.b.c", "a") ?? null, sealed }));
    `;
    const run = spawnSync(process.execPath, ["-e", script], { timeout: 10_000, encoding: "utf8" });
    expect(run.signal).toBeNull();
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
      opened: null,
      sealed: "refused",
    });
  });
});
