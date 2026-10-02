import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { bundleDaemon } from "@ace/release";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test(
  "the bundled daemon starts its notification worker and answers authenticated status without a checkout",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-bundle-"));
    roots.push(root);
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, publicKey);
    const child = spawn(process.execPath, [join(root, "ace.mjs"), "start"], {
      cwd: root,
      env: {
        ...process.env,
        ACE_HOME: join(root, "data"),
        ACE_PORT: "0",
        ACE_VERSION: "1.2.3",
        ACE_DEV: "0",
        ACE_MAINTENANCE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      await new Promise<void>((ready, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("Token file:")) ready();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(errors)));
      });
      const endpoint = await readFile(join(root, "data/daemon-endpoint"), "utf8"),
        token = await readFile(join(root, "data/daemon-token"), "utf8");
      const response = await fetch(endpoint + "/v1/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await response.json()).toMatchObject({ running: true, version: "1.2.3" });
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      expect((await exit)[0]).toBe(0);
    } finally {
      if (child.exitCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  },
);
