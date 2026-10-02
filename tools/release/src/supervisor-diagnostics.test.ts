import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { bundleDaemon } from "@ace/release";

test("a failed supervisor startup caps both diagnostic files and exits without a live daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-diagnostics-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const home = join(root, "home"),
      logs = join(home, "logs");
    await mkdir(logs, { recursive: true });
    for (const name of ["daemon.log", "daemon.err.log"])
      await writeFile(join(logs, name), Buffer.alloc(8 * 1024 * 1024 + 1, 42));
    const key = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, key);
    child = spawn(process.execPath, [join(root, "ace.mjs"), "supervise"], {
      env: { ...process.env, ACE_HOME: home, ACE_AUTO_UPDATE: "0" },
      stdio: "ignore",
    });
    expect((await once(child, "close"))[0]).toBe(1);
    for (const name of await readdir(logs))
      expect((await stat(join(logs, name))).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect((await stat(join(logs, "daemon.log.previous"))).size).toBe(8 * 1024 * 1024);
    expect((await stat(join(logs, "daemon.err.log.previous"))).size).toBe(8 * 1024 * 1024);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
