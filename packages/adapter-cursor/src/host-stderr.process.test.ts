import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";

// The SDK hands MCP servers the host's own stderr, so their output skips the host's line budget.
it("a Cursor host survives an oversized stderr line from a process it inherits stderr to", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-stderr-"));
  const entry = join(root, "host.mjs");
  await writeFile(
    entry,
    `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id } = JSON.parse(line);
  process.stderr.write("x".repeat(65536) + "\\nMCP server ready\\n", () =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { models: [] } }) + "\\n"),
  );
});
`,
  );
  const host = new CursorHost(
    { env: { HOME: root }, entry, limits: { maxFrameBytes: 4096 } },
    () => {},
  );
  try {
    await expect(host.request("models")).resolves.toEqual({ models: [] });
    expect(host.process.signal.aborted).toBe(false);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
