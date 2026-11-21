import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Bun's console writes straight to fd 1, past any process.stdout.write patch, so an SDK log line
// once landed in the JSON-RPC channel and ended the turn as "sent a malformed message".
it("SDK console output during a request never reaches the host's JSON-RPC stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-host-console-"));
  const script = join(dir, "child.ts");
  await writeFile(
    script,
    `import { hostWire } from ${JSON.stringify(new URL("./host-wire.ts", import.meta.url).pathname)};
hostWire(async () => {
  console.log("Warning, gif stream shorter than expected.");
  console.info("  INFO ", "sdk detail");
  console.debug(" DEBUG ", { detail: true });
  console.table([{ a: 1 }]);
  return { ok: true };
}, () => process.exit(0));
`,
  );
  try {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const replied = new Promise<void>((resolve) =>
      child.stdout.on("data", () => stdout.includes("\n") && resolve()),
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send" })}\n`);
    await replied;
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));

    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
    expect(stderr).toContain("gif stream shorter than expected");
    expect(stderr).toContain("sdk detail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
