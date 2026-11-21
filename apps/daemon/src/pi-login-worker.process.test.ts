import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The driver aborts sign-in on any stdout line that is not a frame, and Bun's console writes to
// fd 1 directly, so one log line from the person's installed Pi SDK once failed every sign-in.
it("Pi SDK console output during sign-in never reaches the worker's frame stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-login-worker-"));
  try {
    const sdk = join(dir, "index.js");
    await writeFile(
      sdk,
      `console.log("pi sdk loading");
export class ModelRuntime {
  static async create() { console.info("runtime ready"); return new ModelRuntime(); }
  async login(provider, type, interaction) {
    console.debug("starting", provider, type);
    interaction.notify({ type: "auth_url", url: "https://example.com/authorize" });
    console.log("waiting for the browser");
  }
  async logout() {}
}`,
    );
    const child = spawn(
      process.execPath,
      [
        new URL("./pi-login-worker.ts", import.meta.url).pathname,
        pathToFileURL(sdk).href,
        "login",
        "xai",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(
      stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([{ type: "auth_url", url: "https://example.com/authorize" }, { type: "complete" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
