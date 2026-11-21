import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const apiKey = "crsr_0123456789abcdef0123456789abcdef";

/** Runs hostWire in a real child whose one request logs through `console`, as the SDK does. */
async function hostLogging(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "cursor-host-console-"));
  const script = join(dir, "child.ts");
  await writeFile(
    script,
    `import { hostWire } from ${JSON.stringify(new URL("./host-wire.ts", import.meta.url).pathname)};
hostWire(async () => {
${body}
  return { ok: true };
}, () => process.exit(0));
`,
  );
  try {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CURSOR_API_KEY: apiKey },
    });
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
    return { messages: stdout.split("\n").filter(Boolean), stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Bun's console writes straight to fd 1, past any process.stdout.write patch, so an SDK log line
// once landed in the JSON-RPC channel and ended the turn as "sent a malformed message".
it("SDK console output during a request never reaches the host's JSON-RPC stdout", async () => {
  const { messages, stderr } = await hostLogging(`
  console.log("Warning, gif stream shorter than expected.");
  console.info("  INFO ", "sdk detail");
  console.debug(" DEBUG ", { detail: true });
  console.table([{ a: 1 }]);`);
  expect(messages.map((line) => JSON.parse(line) as unknown)).toEqual([
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
  ]);
  expect(stderr).toContain("gif stream shorter than expected");
  expect(stderr).toContain("sdk detail");
});

// Bun's console.error/warn also skip the process.stderr.write patch, which redacts secrets and
// keeps each line far under the daemon's per-line limit (a longer line stops the host).
it("SDK console errors and warnings reach stderr redacted and within the line budget", async () => {
  const { messages, stderr } = await hostLogging(`
  console.error("request failed with key ${apiKey}");
  console.warn("x".repeat(2_000_000));`);
  expect(messages.map((line) => JSON.parse(line) as unknown)).toEqual([
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
  ]);
  expect(stderr).toContain("request failed with key");
  expect(stderr).not.toContain(apiKey);
  expect(stderr).toContain("SDK stderr exceeded its safe line budget");
  expect(Math.max(...stderr.split("\n").map((line) => line.length))).toBeLessThan(65_536);
});
