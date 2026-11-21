import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The parent parses the worker's whole stdout as one JSON value, so a single SDK log line there
// once hid every saved Pi sign-in.
it("Pi SDK console output leaves the credential worker by neither stdout nor stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-credentials-worker-"));
  try {
    const sdk = join(dir, "index.js");
    await writeFile(
      sdk,
      `console.log("pi sdk loading");
export const ModelRuntime = {
  async create() {
    console.info("runtime ready");
    return { async listCredentials() { console.debug("listing"); return [{ providerId: "xai" }]; } };
  },
};`,
    );
    const child = spawn(
      process.execPath,
      [new URL("./pi-credentials-worker.ts", import.meta.url).pathname, pathToFileURL(sdk).href],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // "close" waits for both pipes to drain; output can still arrive after "exit".
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ providers: ["xai"] });
    // SDK logs may name a secret, so they are discarded, not forwarded.
    expect(stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
