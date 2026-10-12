import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each(["codex", "claude"])(
  "%s account login streams progress before exit and preserves JSON stdout",
  async (provider) => {
    const home = await mkdtemp(join(tmpdir(), "ace-cli-login-"));
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, provider),
      `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const provider = ${JSON.stringify(provider)};
const marker = join(process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR, "synthetic-status");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.2.3"); }
else if (args.includes("status")) {
 const loggedIn = existsSync(marker);
 console.log(provider === "codex" ? loggedIn ? "Logged in using ChatGPT" : "Not logged in" : JSON.stringify({ loggedIn }));
} else {
 console.log("Synthetic device login: https://example.invalid/device CODE-123");
 process.stdin.once("data", () => { writeFileSync(marker, "synthetic"); process.exit(0); });
}
`,
      { mode: 0o700 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./cli.ts", import.meta.url)),
        "accounts",
        "add",
        provider,
        "synthetic",
        join(home, "account"),
        "Synthetic",
        "--json",
      ],
      { env: { ...process.env, ACE_HOME: home, PATH: bin }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      answered = false;
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString();
      if (!answered && stderr.includes("CODE-123")) {
        answered = true;
        expect(stdout).toBe("");
        child.stdin.end("\n");
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(answered).toBe(true);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, status: { auth: "logged_in" } });
    } finally {
      child.kill("SIGKILL");
      await rm(home, { recursive: true, force: true });
    }
  },
);
